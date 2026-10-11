import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob, requireActiveItem } from './guards';
import { writeTransaction } from '../db/tx';

export function revise(db: Db, itemId: number, feedback: string, now = Date.now()): Item {
  const trimmed = feedback.trim();
  if (!trimmed) throw new ActionError('Revision feedback cannot be empty');
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'revise_requested' }, now);
    enqueueJob(tx, 'draft', itemId, { feedback: trimmed }, now);
    logActivity(tx, itemId, `Revision requested: ${trimmed}`, now);
    return item;
  });
}
