import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';
import { errorMessage } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { completeJob, failJob, recordJobFailure } from '@/core/jobs/queue';

/**
 * Runs one claimed job and records the outcome. Shared by the core lane and the agent lane.
 * Failure bookkeeping errors are logged, never thrown, so they cannot crash the worker.
 */
export async function executeJob(db: Db, job: Job, run: () => Promise<void>, now: () => number): Promise<void> {
  const item = getItem(db, job.itemId);
  const start = { triage: item?.triageState ?? null, work: item?.workState ?? null };
  try {
    await run();
    completeJob(db, job.id, now());
  } catch (err) {
    const message = errorMessage(err);
    const t = now();
    try {
      if (failJob(db, job, err, t) === 'failed') {
        recordJobFailure(db, job, start, message, t);
      } else {
        logActivity(db, job.itemId, `Retrying ${job.type} later: ${message}`, t);
      }
    } catch (bookkeepingErr) {
      // A DB error here (e.g. SQLITE_BUSY) must not crash the worker. The job stays `running`
      // and crash recovery picks it up on the next start.
      console.error(`[worker] Could not record the failure of job #${job.id}: ${errorMessage(bookkeepingErr)}`);
    }
  }
}
