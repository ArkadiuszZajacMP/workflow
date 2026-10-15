import type { LinearClient, SlackClient } from '@/core/clients/types';
import type { ConfigStore } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { type PollSource, recordPollError, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import type { JobType } from '@/core/db/schema';
import { PermanentError, errorMessage } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { claimNextJob, completeJob, failJob, recordJobFailure } from '@/core/jobs/queue';
import { createLinearIssueHandler } from './handlers/create-linear-issue';
import { draftHandler } from './handlers/draft';
import { linkLinearIssueHandler } from './handlers/link-linear-issue';
import { triageDraftHandler } from './handlers/triage-draft';
import type { Handler, HandlerContext } from './handlers/types';
import { pollLinear } from './pollers/linear';
import { pollSlack } from './pollers/slack';

export const HANDLERS: Partial<Record<JobType, Handler>> = {
  'triage-draft': triageDraftHandler,
  draft: draftHandler,
  'create-linear-issue': createLinearIssueHandler,
  'link-linear-issue': linkLinearIssueHandler,
};

export async function runNextJob(ctx: HandlerContext, handlers: Partial<Record<JobType, Handler>> = HANDLERS): Promise<boolean> {
  const job = claimNextJob(ctx.db, ctx.now());
  if (!job) return false;
  const startState = getItem(ctx.db, job.itemId)?.triageState ?? null;
  try {
    const handler = handlers[job.type];
    if (!handler) throw new PermanentError(`No handler for ${job.type}`);
    await handler(ctx, job);
    completeJob(ctx.db, job.id, ctx.now());
  } catch (err) {
    const message = errorMessage(err);
    const now = ctx.now();
    try {
      if (failJob(ctx.db, job, err, now) === 'failed') {
        recordJobFailure(ctx.db, job, startState, message, now);
      } else {
        logActivity(ctx.db, job.itemId, `Retrying ${job.type} later: ${message}`, now);
      }
    } catch (bookkeepingErr) {
      // A DB error here (e.g. SQLITE_BUSY) must not crash the worker. The job stays `running`
      // and crash recovery picks it up on the next start.
      console.error(`[worker] Could not record the failure of job #${job.id}: ${errorMessage(bookkeepingErr)}`);
    }
  }
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
