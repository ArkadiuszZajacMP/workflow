import { z } from 'zod';
import type { FailingCheck, ReviewThread } from '@/core/clients/types';
import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { findRepo } from '@/core/repos/map';
import { getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { hasSucceededRun } from '@/core/work/runs';
import type { AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace, registryAuth } from '../workspace';

const outputSchema = z.object({
  addressed: z.array(z.string()),
  notAddressed: z.array(z.object({ threadId: z.string(), reason: z.string() })),
  summary: z.string(),
});

const MAX_TEXT = 4000;
const MAX_LOG = 8000;

function clipStart(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function clipEnd(text: string, max: number): string {
  return text.length > max ? `[truncated]\n${text.slice(text.length - max)}` : text;
}

function escapeTag(text: string, tag: string): string {
  return text.replaceAll(`</${tag}>`, `<\\/${tag}>`);
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function formatThreads(threads: ReviewThread[]): string {
  if (threads.length === 0) return '(none)';
  return threads
    .map((t) => {
      const where = t.path ? ` — ${t.path}${t.line ? `:${t.line}` : ''}` : '';
      const comments = t.comments.map(
        (c) => `- <comment author="${c.author.replaceAll('"', '')}">${escapeTag(clipStart(c.body, MAX_TEXT), 'comment')}</comment>`,
      );
      return [`### Thread ${t.id}${where}`, ...comments].join('\n');
    })
    .join('\n\n');
}

export function formatChecks(checks: FailingCheck[]): string {
  if (checks.length === 0) return '(none)';
  return checks
    .map((c) => {
      const lines = [`### ${c.name}`];
      if (c.summary) lines.push(`<summary>${escapeTag(clipStart(c.summary, MAX_TEXT), 'summary')}</summary>`);
      if (c.logTail) {
        const log = clipEnd(c.logTail, MAX_LOG);
        const fence = fenceFor(log);
        lines.push(fence, log, fence);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export const fixPrHandler: AgentHandler = async (deps, job: Job) => {
  const { plannedPrId } = jobPayload(job as Job & { type: 'fix-pr' });
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (item.workState !== 'implementing' && item.workState !== 'prs_open') return;
  const pr = getPlannedPr(deps.db, plannedPrId);
  if (!pr || pr.itemId !== item.id || pr.state !== 'open' || !pr.prNumber) {
    throw new PermanentError(`Planned PR #${plannedPrId} is not an open PR of item #${item.id}`);
  }
  const label = `${pr.githubRepo}#${pr.prNumber}`;
  const live = await deps.github.getPullRequest(pr.githubRepo, pr.prNumber);
  if (!live) throw new PermanentError(`${label} was not found on GitHub`);
  if (live.state !== 'OPEN') throw new PermanentError(`${label} is not open on GitHub (state ${live.state})`);
  if (live.merged) throw new PermanentError(`${label} is already merged`);
  if (live.headRefName !== pr.branch) {
    throw new PermanentError(`${label} head branch is ${live.headRefName}, expected ${pr.branch}`);
  }
  // A retry of a job whose run already succeeded must not run Claude again.
  if (hasSucceededRun(deps.db, job.id, 'fix-pr')) {
    writeTransaction(deps.db, (tx) => {
      updatePlannedPr(tx, pr.id, { lastError: null }, deps.now());
      updateItem(tx, item.id, { lastError: null }, deps.now());
      logActivity(tx, item.id, `Fix round for PR ${pr.position} (${label}) already completed`, deps.now());
    });
    return;
  }
  const [threads, checks] = await Promise.all([
    deps.github.unresolvedThreads(pr.githubRepo, pr.prNumber),
    deps.github.failingChecks(pr.githubRepo, pr.prNumber),
  ]);
  if (threads.length === 0 && checks.length === 0) {
    writeTransaction(deps.db, (tx) =>
      logActivity(tx, item.id, `Nothing to fix on ${label}: no unresolved threads or failing checks`, deps.now()),
    );
    return;
  }
  const repo = findRepo(deps.repoMap(), pr.repoKey);
  if (!repo) throw new PermanentError(`Unknown repository "${pr.repoKey}"`);
  await ensureWorkspace(deps, item, [pr.repoKey]);
  const auth = await registryAuth(deps, repo);
  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-fix', {
    identifier: item.linearIdentifier ?? `#${item.id}`,
    githubRepo: pr.githubRepo,
    repoPath: `/work/${pr.repoKey}`,
    prNumber: String(pr.prNumber),
    prUrl: pr.prUrl ?? '',
    branch: pr.branch,
    threads: formatThreads(threads),
    checks: formatChecks(checks),
    validation: repo.validationCommands.length ? repo.validationCommands.map((c) => `- ${c}`).join('\n') : '(none configured)',
  });
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken, GH_TOKEN: deps.secrets.ghToken };
  if (auth) env.CODEARTIFACT_AUTH_TOKEN = auth.token;
  const output = await runAgent(deps, {
    job,
    item,
    plannedPrId: pr.id,
    kind: 'fix-pr',
    prompt,
    schema: outputSchema,
    env,
    registry: auth?.registry ?? null,
  });
  const known = new Set(threads.map((t) => t.id));
  const addressed = output.addressed.filter((id) => known.has(id)).length;
  const left = output.notAddressed.filter((n) => known.has(n.threadId)).length;
  writeTransaction(deps.db, (tx) => {
    updatePlannedPr(tx, pr.id, { lastError: null }, deps.now());
    updateItem(tx, item.id, { lastError: null }, deps.now());
    logActivity(
      tx,
      item.id,
      `Fix round on ${label}: addressed ${addressed}, left ${left} — ${output.summary}`,
      deps.now(),
    );
  });
};
