import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { requireItem } from '../items';
import { hasActiveJob } from '../jobs/queue';

export function assertNoActiveJob(db: Db, itemId: number): void {
  if (hasActiveJob(db, itemId)) throw new ActionError(`Item #${itemId} already has a job in progress`);
}

/** Triage actions are off for dismissed items. Move the item back to a column first. */
export function requireActiveItem(db: Db, itemId: number): Item {
  const item = requireItem(db, itemId);
  if (item.category === 'dismissed') throw new ActionError(`Item #${itemId} is dismissed`);
  return item;
}
