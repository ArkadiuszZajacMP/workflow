import type { Db } from '../db/client';
import type { Item, WorkState } from '../db/schema';
import { ActionError } from '../errors';
import { getItem, logActivity, requireItem, updateItem } from '../items';
import { transitionWork, type WorkEvent } from './machine';

export function applyWorkEvent(db: Db, itemId: number, event: WorkEvent, now = Date.now()): Item {
  const item = requireItem(db, itemId);
  const result = transitionWork(item.workState, event);
  if (!result.ok) throw new ActionError(`Item #${itemId}: ${result.error}`);
  return updateItem(db, itemId, { workState: result.state, lastError: null }, now);
}

export function markWorkFailed(
  db: Db,
  itemId: number,
  fromState: WorkState | null,
  message: string,
  now = Date.now(),
): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const canFail = fromState !== null && transitionWork(item.workState, { type: 'job_failed' }).ok;
  updateItem(
    db,
    itemId,
    canFail ? { workState: 'failed', workFailedFromState: fromState, lastError: message } : { lastError: message },
    now,
  );
  logActivity(db, itemId, `Failed: ${message}`, now);
}
