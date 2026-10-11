import { eq } from 'drizzle-orm';
import type { Rule } from './config/schema';
import type { Db } from './db/client';
import { type Item, sourceEvents } from './db/schema';
import type { SourceEvent } from './events';
import {
  findItemByLinearIssue,
  findItemBySlackThread,
  getItem,
  logActivity,
  updateItem,
  upsertLinearItem,
  upsertSlackItem,
} from './items';
import { enqueueJob } from './jobs/queue';
import { rearmStrandedJob } from './jobs/rearm';
import { matchRule, type RuleMatch } from './rules/match';
import { writeTransaction } from './db/tx';

export type IngestResult = { inserted: boolean; item: Item | null };

/**
 * Stores the event (deduplicated by `externalKey`) and, when it matches a rule,
 * creates or moves its item and enqueues the rule's action. Runs in one transaction.
 * Pass `rules = null` to record the event as already seen without matching it.
 */
export function ingestEvent(
  db: Db,
  event: SourceEvent,
  externalKey: string,
  rules: Rule[] | null,
  now = Date.now(),
): IngestResult {
  return writeTransaction(db, (tx) => {
    const row = tx
      .insert(sourceEvents)
      .values({ source: event.source, kind: event.kind, externalKey, payload: event, seenAt: now })
      .onConflictDoNothing()
      .returning({ id: sourceEvents.id })
      .get();
    if (!row) return { inserted: false, item: null };
    if (!rules) return { inserted: true, item: null };
    const match = matchRule(event, rules);
    if (!match) return { inserted: true, item: null };
    return { inserted: true, item: applyRuleMatch(tx, event, row.id, match, now) };
  });
}

function applyRuleMatch(db: Db, event: SourceEvent, eventId: number, match: RuleMatch, now: number): Item {
  const before =
    event.source === 'slack'
      ? findItemBySlackThread(db, event.channel, event.threadTs)
      : findItemByLinearIssue(db, event.issue.id);
  const item =
    event.source === 'slack'
      ? upsertSlackItem(db, { channel: event.channel, threadTs: event.threadTs }, match.category, now)
      : upsertLinearItem(db, event.issue, match.category, now);
  db.update(sourceEvents).set({ itemId: item.id }).where(eq(sourceEvents.id, eventId)).run();
  logActivity(db, item.id, describeEvent(event), now);
  if (match.action === 'triage-draft' && item.triageState === null) {
    updateItem(db, item.id, { triageState: 'new' }, now);
    enqueueJob(db, 'triage-draft', item.id, {}, now);
  } else if (before?.category === 'dismissed' && item.category !== 'dismissed') {
    const job = rearmStrandedJob(db, item, now);
    if (job) logActivity(db, item.id, `Resuming ${job.type}`, now);
  }
  return getItem(db, item.id)!;
}

export function describeEvent(event: SourceEvent): string {
  switch (event.kind) {
    case 'reaction_added':
      return `:${event.reaction}: added in Slack`;
    case 'status_changed':
      return `${event.issue.identifier} status → ${event.status}`;
    case 'label_added':
      return `${event.issue.identifier} labeled ${event.label}`;
  }
}
