import type { LinearClient, SlackClient } from '@/core/clients/types';
import type { ConfigStore } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { type PollSource, recordPollError, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { CORE_JOB_TYPES, type JobType } from '@/core/db/schema';
import { errorMessage, PermanentError } from '@/core/errors';
import { claimNextJob } from '@/core/jobs/queue';
import { executeJob } from './execute';
import { createLinearIssueHandler } from './handlers/create-linear-issue';
import { draftHandler } from './handlers/draft';
import { linkLinearIssueHandler } from './handlers/link-linear-issue';
import { postPlanHandler } from './handlers/post-plan';
import { triageDraftHandler } from './handlers/triage-draft';
import type { Handler, HandlerContext } from './handlers/types';
import { pollLinear } from './pollers/linear';
import { pollSlack } from './pollers/slack';

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
  deps: { db: Db; slack: SlackClient; linear: LinearClient; configStore: Pick<ConfigStore, 'reload'> },
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
  return config;
}
