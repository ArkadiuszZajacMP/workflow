import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, requireItem, updateItem } from '../items';
import { writeTransaction } from '../db/tx';
import { requestAgentStop } from '../jobs/queue';

export function discard(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireItem(tx, itemId);
    if (item.category === 'dismissed') throw new ActionError(`Item #${itemId} is already dismissed`);
    const updated = updateItem(tx, itemId, { category: 'dismissed' }, now);
    logActivity(tx, itemId, 'Dismissed', now);
    const job = requestAgentStop(tx, itemId);
    if (job) logActivity(tx, itemId, `Stop requested for ${job.type}`, now);
    return updated;
  });
}
