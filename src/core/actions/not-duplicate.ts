import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { applyTriageEvent, logActivity } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob, requireActiveItem } from './guards';

export function notDuplicate(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    requireActiveItem(tx, itemId);
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'not_duplicate' }, now);
    enqueueJob(tx, 'draft', itemId, {}, now);
    logActivity(tx, itemId, 'Marked as not a duplicate, drafting a new issue', now);
    return item;
  });
}
