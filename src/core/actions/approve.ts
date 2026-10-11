import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { latestDraft } from '../drafts';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob, requireActiveItem } from './guards';

export function approve(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    requireActiveItem(tx, itemId);
    if (!latestDraft(tx, itemId)) throw new ActionError(`Item #${itemId} has no draft to approve`);
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'approved' }, now);
    enqueueJob(tx, 'create-linear-issue', itemId, { issueUuid: randomUUID() }, now);
    logActivity(tx, itemId, 'Draft approved, creating Linear issue', now);
    return item;
  });
}
