import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type Activity, activity, type Category, type Item, items, type NewItem, type TriageState } from './db/schema';
import { ActionError, PermanentError } from './errors';
import { type TriageEvent, transition } from './triage/machine';
import type { LinearIssueRef } from './types';

export type ItemPatch = Partial<Omit<NewItem, 'id' | 'createdAt' | 'updatedAt'>>;

export function getItem(db: Db, id: number): Item | undefined {
  return db.select().from(items).where(eq(items.id, id)).get();
}

export function requireItem(db: Db, id: number): Item {
  const item = getItem(db, id);
  if (!item) throw new ActionError(`Item #${id} not found`);
  return item;
}

export function updateItem(db: Db, id: number, patch: ItemPatch, now = Date.now()): Item {
  return db
    .update(items)
    .set({ ...patch, updatedAt: now })
    .where(eq(items.id, id))
    .returning()
    .get();
}

export function logActivity(db: Db, itemId: number, message: string, now = Date.now()): void {
  db.insert(activity).values({ itemId, message, createdAt: now }).run();
}

export function listActivity(db: Db, itemId: number): Activity[] {
  return db.select().from(activity).where(eq(activity.itemId, itemId)).orderBy(asc(activity.id)).all();
}

export function applyTriageEvent(db: Db, itemId: number, event: TriageEvent, now = Date.now()): Item {
  const item = requireItem(db, itemId);
  const result = transition(item.triageState, event);
  if (!result.ok) throw new ActionError(`Item #${itemId}: ${result.error}`);
  return updateItem(db, itemId, { triageState: result.state, lastError: null }, now);
}

export function findItemBySlackThread(db: Db, channel: string, threadTs: string): Item | undefined {
  return db
    .select()
    .from(items)
    .where(and(eq(items.slackChannel, channel), eq(items.slackThreadTs, threadTs)))
    .get();
}

export function findItemByLinearIssue(db: Db, issueId: string): Item | undefined {
  return db.select().from(items).where(eq(items.linearIssueId, issueId)).get();
}

/** Throws when `issue` already belongs to another Slack item. A Linear-only owner can be merged instead. */
export function assertCanClaimLinearIssue(db: Db, itemId: number, issue: LinearIssueRef): void {
  const owner = findItemByLinearIssue(db, issue.id);
  if (owner && owner.id !== itemId && owner.slackThreadTs) {
    throw new PermanentError(`${issue.identifier} is already linked to item #${owner.id}`);
  }
}

export function upsertSlackItem(
  db: Db,
  thread: { channel: string; threadTs: string },
  category: Category,
  now = Date.now(),
): Item {
  const existing = findItemBySlackThread(db, thread.channel, thread.threadTs);
  if (existing) return updateItem(db, existing.id, { category }, now);
  return db
    .insert(items)
    .values({ category, slackChannel: thread.channel, slackThreadTs: thread.threadTs, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function upsertLinearItem(db: Db, issue: LinearIssueRef, category: Category, now = Date.now()): Item {
  const existing = findItemByLinearIssue(db, issue.id);
  if (existing) return updateItem(db, existing.id, { category }, now);
  return db
    .insert(items)
    .values({
      category,
      title: issue.title,
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Points `itemId` at a Linear issue. If the Linear poller already created a separate,
 * Linear-only item for that issue, that item is merged (dismissed) into this one.
 */
export function claimLinearIssue(db: Db, itemId: number, issue: LinearIssueRef, now = Date.now()): void {
  db.transaction((tx) => {
    assertCanClaimLinearIssue(tx, itemId, issue);
    const owner = findItemByLinearIssue(tx, issue.id);
    if (owner && owner.id !== itemId) {
      updateItem(tx, owner.id, { linearIssueId: null, linearIdentifier: null, linearUrl: null, category: 'dismissed' }, now);
      logActivity(tx, owner.id, `Merged into item #${itemId}`, now);
    }
    updateItem(tx, itemId, { linearIssueId: issue.id, linearIdentifier: issue.identifier, linearUrl: issue.url }, now);
  });
}

export function markItemFailed(
  db: Db,
  itemId: number,
  fromState: TriageState | null,
  message: string,
  now = Date.now(),
): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const canFail = fromState !== null && transition(item.triageState, { type: 'job_failed' }).ok;
  updateItem(
    db,
    itemId,
    canFail ? { triageState: 'failed', failedFromState: fromState, lastError: message } : { lastError: message },
    now,
  );
  logActivity(db, itemId, `Failed: ${message}`, now);
}
