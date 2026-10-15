import { z } from 'zod';
import type { PullRequestInfo } from '@/core/clients/types';
import type { Job, PlannedPr } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob, hasActiveJobFor, jobPayload } from '@/core/jobs/queue';
import { findRepo } from '@/core/repos/map';
import { allPrsOpen, getPlannedPr, listPlannedPrs, nextPendingPr, updatePlannedPr } from '@/core/work/planned-prs';
import { latestPlan } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { AgentDeps, AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace, registryAuth } from '../workspace';

const outputSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
  branch: z.string().min(1),
  summary: z.string(),
});

function markOpen(deps: AgentDeps, pr: PlannedPr, info: PullRequestInfo): void {
  updatePlannedPr(
    deps.db,
    pr.id,
    { state: 'open', prNumber: info.number, prUrl: info.url, isDraft: info.isDraft, branch: info.headRefName, lastError: null },
    deps.now(),
  );
  logActivity(deps.db, pr.itemId, `Opened ${pr.githubRepo}#${info.number} (PR ${pr.position})`, deps.now());
}

/** Queues the next planned PR, or finishes implementation when every planned PR is open. */
export function afterPrOpened(deps: AgentDeps, itemId: number): void {
  writeTransaction(deps.db, (tx) => {
    const item = getItem(tx, itemId);
    if (!item || item.category === 'dismissed' || item.workState !== 'implementing') return;
    const next = nextPendingPr(tx, itemId);
    if (next) {
      // A re-run of an already-succeeded job must not queue the same PR twice.
      if (!hasActiveJobFor(tx, 'implement-pr', itemId, (p) => p.plannedPrId === next.id)) {
        enqueueJob(tx, 'implement-pr', itemId, { plannedPrId: next.id }, deps.now());
      }
      return;
    }
    if (!allPrsOpen(tx, itemId)) return;
    applyWorkEvent(tx, itemId, { type: 'all_prs_open' }, deps.now());
    updateItem(tx, itemId, { category: 'verification' }, deps.now());
    logActivity(tx, itemId, 'All planned PRs are open; moved to Verification', deps.now());
  });
}

export const implementPrHandler: AgentHandler = async (deps, job: Job) => {
  const { plannedPrId } = jobPayload(job as Job & { type: 'implement-pr' });
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'implementing') return;
  const pr = getPlannedPr(deps.db, plannedPrId);
  if (!pr || pr.itemId !== item.id) throw new PermanentError(`Planned PR #${plannedPrId} does not belong to item #${item.id}`);
  if (pr.state === 'open') return afterPrOpened(deps, item.id);

  // After a crash or restart the PR may already exist. Never open a second one.
  const existing = await deps.github.findOpenPrForBranch(pr.githubRepo, pr.branch);
  if (existing) {
    markOpen(deps, pr, existing);
    return afterPrOpened(deps, item.id);
  }

  updatePlannedPr(deps.db, pr.id, { state: 'implementing', lastError: null }, deps.now());
  const repo = findRepo(deps.repoMap(), pr.repoKey);
  if (!repo) throw new PermanentError(`Unknown repository "${pr.repoKey}"`);
  if (!item.linearIssueId) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const issue = await deps.linear.getIssueDetails(item.linearIssueId);
  if (!issue) throw new PermanentError(`Linear issue ${item.linearIdentifier} not found`);
  await ensureWorkspace(deps, item, [pr.repoKey]);

  const all = listPlannedPrs(deps.db, item.id);
  const prior = all.filter((p) => p.state === 'open' && p.prUrl);
  const auth = await registryAuth(deps, repo);
  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-implement', {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '(no description)',
    linearUrl: issue.url,
    planBody: latestPlan(deps.db, item.id)?.body ?? '(missing)',
    position: String(pr.position),
    total: String(all.length),
    repo: repo.key,
    githubRepo: repo.repo,
    repoPath: `/work/${repo.key}`,
    defaultBranch: repo.defaultBranch,
    branch: pr.branch,
    scope: pr.scope,
    priorPrs: prior.length ? prior.map((p) => `- PR ${p.position}: ${p.prUrl}`).join('\n') : '(none)',
    validation: repo.validationCommands.length ? repo.validationCommands.map((c) => `- ${c}`).join('\n') : '(none configured)',
  });
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken, GH_TOKEN: deps.secrets.ghToken };
  if (auth) env.CODEARTIFACT_AUTH_TOKEN = auth.token;
  const output = await runAgent(deps, {
    job,
    item,
    plannedPrId: pr.id,
    kind: 'implement-pr',
    prompt,
    schema: outputSchema,
    env,
    registry: auth?.registry ?? null,
  });

  const info = await deps.github.getPullRequest(pr.githubRepo, output.prNumber);
  if (!info || info.state !== 'OPEN' || info.headRefName !== pr.branch) {
    throw new PermanentError(
      `Claude reported PR #${output.prNumber} but GitHub shows no open PR #${output.prNumber} for branch ${pr.branch} in ${pr.githubRepo}`,
    );
  }
  if (!info.isDraft) {
    logActivity(deps.db, pr.itemId, `Warning: ${pr.githubRepo}#${info.number} was opened as a ready PR, not a draft`, deps.now());
  }
  markOpen(deps, pr, info);
  afterPrOpened(deps, item.id);
};
