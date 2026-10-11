import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, updateItem } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob, requireActiveItem } from './guards';

const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const LINKABLE = ['duplicate_suspected', 'draft_ready'] as const;

export function link(db: Db, itemId: number, target: { identifier: string; issueId?: string }, now = Date.now()): Item {
  const identifier = target.identifier.trim().toUpperCase();
  if (!IDENTIFIER.test(identifier)) throw new ActionError(`"${target.identifier}" is not a Linear identifier like ENG-123`);
  return db.transaction((tx) => {
    const item = requireActiveItem(tx, itemId);
    if (!LINKABLE.includes(item.triageState as (typeof LINKABLE)[number])) {
      throw new ActionError(`Item #${itemId} can only be linked when a duplicate is suspected or a draft is ready`);
    }
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'link-linear-issue', itemId, target.issueId ? { identifier, issueId: target.issueId } : { identifier }, now);
    logActivity(tx, itemId, `Linking to ${identifier}`, now);
    return item.lastError === null ? item : updateItem(tx, itemId, { lastError: null }, now);
  });
}
