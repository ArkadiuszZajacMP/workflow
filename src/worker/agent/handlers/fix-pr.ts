import { z } from 'zod';
import type { FailingCheck, ReviewThread } from '@/core/clients/types';
import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { findRepo } from '@/core/repos/map';
import { getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import type { AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace, registryAuth } from '../workspace';

const outputSchema = z.object({
  addressed: z.array(z.string()),
  notAddressed: z.array(z.object({ threadId: z.string(), reason: z.string() })),
  summary: z.string(),
});

export function formatThreads(threads: ReviewThread[]): string {
  if (threads.length === 0) return '(none)';
  return threads
    .map((t) => {
      const where = t.path ? ` — ${t.path}${t.line ? `:${t.line}` : ''}` : '';
      return [`### Thread ${t.id}${where}`, ...t.comments.map((c) => `- @${c.author}: ${c.body}`)].join('\n');
    })
    .join('\n\n');
}

export function formatChecks(checks: FailingCheck[]): string {
  if (checks.length === 0) return '(none)';
  return checks
    .map((c) => [`### ${c.name}${c.summary ? ` — ${c.summary}` : ''}`, ...(c.logTail ? ['```', c.logTail, '```'] : [])].join('\n'))
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
  const [threads, checks] = await Promise.all([
    deps.github.unresolvedThreads(pr.githubRepo, pr.prNumber),
    deps.github.failingChecks(pr.githubRepo, pr.prNumber),
  ]);
  if (threads.length === 0 && checks.length === 0) {
    logActivity(deps.db, item.id, `Nothing to fix on ${label}: no unresolved threads or failing checks`, deps.now());
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
  writeTransaction(deps.db, (tx) => {
    updatePlannedPr(tx, pr.id, { lastError: null }, deps.now());
    updateItem(tx, item.id, { lastError: null }, deps.now());
    logActivity(
      tx,
      item.id,
      `Fix round on ${label}: addressed ${output.addressed.length}, left ${output.notAddressed.length} — ${output.summary}`,
      deps.now(),
    );
  });
};
