import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity, requireItem, updateItem } from '../items';
import { latestFailedJob, requeueJob } from '../jobs/queue';

export function retry(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (item.triageState !== 'failed') throw new ActionError(`Item #${itemId} has not failed`);
    const job = latestFailedJob(tx, itemId);
    if (!job) throw new ActionError(`Item #${itemId} has no failed job to retry`);
    applyTriageEvent(tx, itemId, { type: 'retry', to: item.failedFromState ?? 'new' }, now);
    requeueJob(tx, job.id, now);
    logActivity(tx, itemId, `Retrying ${job.type}`, now);
    return updateItem(tx, itemId, { lastError: null, failedFromState: null }, now);
  });
}
