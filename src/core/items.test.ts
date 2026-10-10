import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { ActionError, PermanentError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import {
  applyTriageEvent,
  claimLinearIssue,
  getItem,
  listActivity,
  markItemFailed,
  upsertLinearItem,
  upsertSlackItem,
} from './items';

const issue = { id: 'i1', identifier: 'ENG-1', title: 'Broken export', url: 'https://linear.app/x/ENG-1' };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

describe('upserts', () => {
  it('creates one item per Slack thread and moves it on later matches', () => {
    const a = upsertSlackItem(db, { channel: 'C1', threadTs: '1.0' }, 'triage', 10);
    const b = upsertSlackItem(db, { channel: 'C1', threadTs: '1.0' }, 'done', 20);
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ category: 'done', updatedAt: 20 });
  });

  it('creates Linear items with the issue title and reference', () => {
    const item = upsertLinearItem(db, issue, 'triage', 10);
    expect(item).toMatchObject({ title: 'Broken export', linearIssueId: 'i1', linearIdentifier: 'ENG-1' });
    expect(upsertLinearItem(db, issue, 'in_progress', 20).id).toBe(item.id);
  });
});

describe('applyTriageEvent', () => {
  it('moves the item and rejects invalid events with ActionError', () => {
    const item = seedItem(db, { triageState: 'draft_ready' });
    expect(applyTriageEvent(db, item.id, { type: 'approved' }, 5).triageState).toBe('creating_issue');
    expect(() => applyTriageEvent(db, item.id, { type: 'approved' }, 6)).toThrow(ActionError);
  });
});

describe('claimLinearIssue', () => {
  it('merges a Linear-only item that already owns the issue', () => {
    const linearOnly = upsertLinearItem(db, issue, 'triage', 10);
    const slackItem = seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' });
    claimLinearIssue(db, slackItem.id, issue, 20);
    expect(getItem(db, slackItem.id)).toMatchObject({ linearIssueId: 'i1', linearIdentifier: 'ENG-1' });
    expect(getItem(db, linearOnly.id)).toMatchObject({ linearIssueId: null, category: 'dismissed' });
    expect(listActivity(db, linearOnly.id).map((a) => a.message)).toContain(`Merged into item #${slackItem.id}`);
  });

  it('refuses to steal an issue linked to another Slack thread', () => {
    seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0', linearIssueId: 'i1' });
    const other = seedItem(db, { slackChannel: 'C1', slackThreadTs: '2.0' });
    expect(() => claimLinearIssue(db, other.id, issue, 20)).toThrow(PermanentError);
  });
});

describe('markItemFailed', () => {
  it('fails the item and remembers where to retry from', () => {
    const item = seedItem(db, { triageState: 'checking_duplicates' });
    markItemFailed(db, item.id, 'new', 'Slack API error: channel_not_found', 30);
    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'failed',
      failedFromState: 'new',
      lastError: 'Slack API error: channel_not_found',
    });
  });

  it('only records the error when the item cannot fail', () => {
    const item = seedItem(db, { triageState: 'linked' });
    markItemFailed(db, item.id, 'linked', 'boom', 30);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', lastError: 'boom' });
  });
});
