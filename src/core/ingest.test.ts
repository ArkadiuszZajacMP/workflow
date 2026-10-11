import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { eq } from 'drizzle-orm';
import { items, jobs, sourceEvents } from '@/core/db/schema';
import type { LinearStatusEvent, SlackReactionEvent } from '@/core/events';
import { createTestDb } from '@/test/db';
import { ingestEvent } from './ingest';
import { listActivity } from './items';

const rules: Rule[] = [
  { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
  { when: { source: 'linear', status: 'Triage' }, category: 'triage' },
];
const eyes = (ts: string, threadTs = '1.0'): SlackReactionEvent => ({
  source: 'slack', kind: 'reaction_added', reaction: 'eyes', channel: 'C1', ts, threadTs,
});

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

describe('ingestEvent', () => {
  it('creates a triage item and a triage-draft job for 👀', () => {
    const result = ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    expect(result.inserted).toBe(true);
    expect(result.item).toMatchObject({ category: 'triage', triageState: 'new', slackThreadTs: '1.0' });
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'triage-draft', itemId: result.item!.id }]);
    expect(listActivity(db, result.item!.id).map((a) => a.message)).toEqual([':eyes: added in Slack']);
  });

  it('ignores an event it has already seen', () => {
    ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    expect(ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 20)).toEqual({ inserted: false, item: null });
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('reuses the thread item for a 👀 on a reply and does not start a second triage', () => {
    const first = ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    const reply = ingestEvent(db, eyes('1.5'), 'slack:C1:1.5:eyes', rules, 20);
    expect(reply.item?.id).toBe(first.item?.id);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('re-arms triage when a 👀 brings back a dismissed item stranded in new', () => {
    const first = ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    const itemId = first.item!.id;
    db.update(items).set({ category: 'dismissed' }).where(eq(items.id, itemId)).run();
    db.update(jobs).set({ status: 'done' }).run(); // the handler skipped the dismissed item

    const again = ingestEvent(db, eyes('1.5'), 'slack:C1:1.5:eyes', rules, 20);
    expect(again.item).toMatchObject({ id: itemId, category: 'triage', triageState: 'new' });
    expect(db.select().from(jobs).all()).toMatchObject([
      { type: 'triage-draft', status: 'done' },
      { type: 'triage-draft', status: 'queued', itemId },
    ]);
  });

  it('records unmatched events without creating items', () => {
    const result = ingestEvent(db, { ...eyes('1.0'), reaction: 'tada' }, 'slack:C1:1.0:tada', rules, 10);
    expect(result).toEqual({ inserted: true, item: null });
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
  });

  it('records but never matches when rules are null (first-run baseline)', () => {
    expect(ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', null, 10)).toEqual({ inserted: true, item: null });
  });

  it('creates Linear items without jobs', () => {
    const event: LinearStatusEvent = {
      source: 'linear', kind: 'status_changed', status: 'Triage',
      issue: { id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u' },
    };
    const result = ingestEvent(db, event, 'linear:i1:status:Triage:t', rules, 10);
    expect(result.item).toMatchObject({ linearIdentifier: 'ENG-1', triageState: null, category: 'triage' });
    expect(db.select().from(jobs).all()).toHaveLength(0);
  });
});
