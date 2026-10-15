import type { GitHubClient, LinearClient, SlackClient } from '@/core/clients/types';
import type { ConfigStore } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { getCursor, type PollSource, recordPollError, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { CORE_JOB_TYPES, type JobType } from '@/core/db/schema';
import { errorMessage, PermanentError } from '@/core/errors';
import { claimNextJob } from '@/core/jobs/queue';
import { enqueueWorkspaceGc } from '@/core/work/gc';
import { executeJob } from './execute';
import { createLinearIssueHandler } from './handlers/create-linear-issue';
import { draftHandler } from './handlers/draft';
import { linkLinearIssueHandler } from './handlers/link-linear-issue';
import { postPlanHandler } from './handlers/post-plan';
import { triageDraftHandler } from './handlers/triage-draft';
import type { Handler, HandlerContext } from './handlers/types';
import { pollGithub } from './pollers/github';
import { pollLinear } from './pollers/linear';
import { pollSlack } from './pollers/slack';

export const AGENT_NOT_CONFIGURED =
  'agent workers not configured — add GITHUB_TOKEN, GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN references to .env.op';

export const HANDLERS: Partial<Record<JobType, Handler>> = {
  'triage-draft': triageDraftHandler,
  draft: draftHandler,
  'create-linear-issue': createLinearIssueHandler,
  'link-linear-issue': linkLinearIssueHandler,
  'post-plan': postPlanHandler,
};

export async function runNextJob(ctx: HandlerContext, handlers: Partial<Record<JobType, Handler>> = HANDLERS): Promise<boolean> {
  const job = claimNextJob(ctx.db, ctx.now(), CORE_JOB_TYPES);
  if (!job) return false;
  const handler = handlers[job.type];
  await executeJob(
    ctx.db,
    job,
    () => (handler ? handler(ctx, job) : Promise.reject(new PermanentError(`No handler for ${job.type}`))),
    ctx.now,
  );
  return true;
}

export async function pollOnce(
  deps: { db: Db; slack: SlackClient; linear: LinearClient; configStore: Pick<ConfigStore, 'reload'>; github?: GitHubClient | null },
  now = Date.now(),
): Promise<Config | null> {
  const { db, slack, linear } = deps;
  const { config, error } = deps.configStore.reload();
  if (error) recordPollError(db, 'config', error, now);
  else recordPollSuccess(db, 'config', null, now);
  if (!config) return null;

  const pollers: [PollSource, () => Promise<unknown>][] = [
    ['slack', () => pollSlack({ db, slack, config }, now)],
    ['linear', () => pollLinear({ db, linear, config }, now)],
  ];
  for (const [source, poll] of pollers) {
    try {
      await poll();
    } catch (err) {
      recordPollError(db, source, errorMessage(err), now);
      console.error(`[worker] ${source} poll failed: ${errorMessage(err)}`);
    }
  }
  if (deps.github) {
    const cursor = getCursor(db, 'github');
    // A failed attempt also counts, so retries wait prPollSeconds instead of hammering GitHub every cycle.
    const last = Math.max(cursor?.lastSuccessAt ?? 0, cursor?.lastErrorAt ?? 0);
    const intervalMs = config.agent.prPollSeconds * 1000;
    if (now - last >= intervalMs) {
      try {
        await pollGithub({ db, github: deps.github, intervalMs }, now);
      } catch (err) {
        recordPollError(db, 'github', errorMessage(err), now);
        console.error(`[worker] github poll failed: ${errorMessage(err)}`);
      }
    }
  } else if (deps.github === null) {
    recordPollError(db, 'github', AGENT_NOT_CONFIGURED, now);
  }
  try {
    enqueueWorkspaceGc(db, config.agent.workspaceRetentionDays, now);
  } catch (err) {
    console.error(`[worker] workspace GC failed: ${errorMessage(err)}`);
  }
  return config;
}
