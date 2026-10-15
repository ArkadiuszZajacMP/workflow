import { z } from 'zod';
import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { type RepoMap, validateBreakdown } from '@/core/repos/map';
import { formatThread } from '@/core/triage/format';
import { latestPlan, renderPlanComment, savePlan } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace } from '../workspace';

export function planOutputSchema(map: RepoMap) {
  return z
    .object({
      body: z.string().trim().min(1),
      breakdown: z.array(z.object({ repo: z.string().trim().min(1), scope: z.string().trim().min(1) })).min(1),
      summary: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const error = validateBreakdown(value.breakdown, map);
      if (error) ctx.addIssue({ code: 'custom', message: error });
    });
}

export const investigateHandler: AgentHandler = async (deps, job: Job) => {
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'investigating') return;
  if (!item.linearIssueId || !item.linearIdentifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const issue = await deps.linear.getIssueDetails(item.linearIssueId);
  if (!issue) throw new PermanentError(`Linear issue ${item.linearIdentifier} not found`);

  const map = deps.repoMap();
  const { feedback } = jobPayload(job as Job & { type: 'investigate' });
  const previous = feedback ? latestPlan(deps.db, item.id) : undefined;
  let repos = previous ? [...new Set(previous.breakdown.map((e) => e.repo))] : [];
  if (repos.length === 0) {
    const detected = await deps.host.detectRepository({
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      comments: issue.comments,
    });
    repos = detected ? [detected] : deps.config.agent.defaultRepos;
  }
  if (repos.length === 0) {
    throw new PermanentError('No repository detected for this issue. Set agent.defaultRepos in workflow.config.yaml or mention the repository in the issue.');
  }
  await ensureWorkspace(deps, item, repos);

  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-investigate', {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '(no description)',
    thread: item.slackThread?.length ? formatThread(item.slackThread) : '(none)',
    repos: repos.map((key) => `- ${key} (/work/${key})`).join('\n'),
    knownRepos: map.repos.map((r) => r.key).join(', '),
    previousPlan: previous ? renderPlanComment(previous) : '(none)',
    feedback: feedback ?? '(none)',
  });
  const output = await runAgent(deps, {
    job,
    item,
    kind: 'investigate',
    prompt,
    schema: planOutputSchema(map),
    env: { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken },
  });

  if (getItem(deps.db, item.id)?.category === 'dismissed') return;
  const now = deps.now();
  writeTransaction(deps.db, (tx) => {
    const plan = savePlan(tx, item.id, { body: output.body, breakdown: output.breakdown }, 'claude', feedback ?? null, now);
    applyWorkEvent(tx, item.id, { type: 'plan_saved' }, now);
    logActivity(tx, item.id, `Plan v${plan.version} by Claude (${output.breakdown.length} PR${output.breakdown.length === 1 ? '' : 's'})`, now);
  });
};
