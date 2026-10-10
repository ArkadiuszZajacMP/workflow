import { beforeEach, describe, expect, it } from 'vitest';
import type { LinearIssueState } from '@/core/clients/types';
import { getCursor } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { items, sourceEvents } from '@/core/db/schema';
import { createTestDb } from '@/test/db';
import { FakeLinear, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { diffIssue, pollLinear } from './linear';

const issue = (overrides: Partial<LinearIssueState> = {}): LinearIssueState => ({
  id: 'i1', identifier: 'ENG-1', title: 'Export fails', url: 'u',
  status: 'Backlog', labels: [], updatedAt: '2026-10-10T10:00:00.000Z', ...overrides,
});

let db: Db;
let linear: FakeLinear;
beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
});

describe('diffIssue', () => {
  it('emits current status and all labels for an unseen issue', () => {
    expect(diffIssue(undefined, issue({ labels: ['bug'] })).map((d) => d.key)).toEqual([
      'linear:i1:status:Backlog:2026-10-10T10:00:00.000Z',
      'linear:i1:label:bug:2026-10-10T10:00:00.000Z',
    ]);
  });

  it('emits only what changed, and nothing for removed labels', () => {
    const snapshot = { issueId: 'i1', statusName: 'Backlog', labelNames: ['bug', 'old'], updatedAt: 't0' };
    const diffs = diffIssue(snapshot, issue({ status: 'Backlog', labels: ['bug', 'needs-investigation'] }));
    expect(diffs.map((d) => d.event)).toMatchObject([{ kind: 'label_added', label: 'needs-investigation' }]);
    expect(diffIssue(snapshot, issue({ labels: ['bug'] }))).toEqual([]);
  });
});

describe('pollLinear', () => {
  it('queues issues that match a rule and advances the cursor to the newest updatedAt', async () => {
    linear.setIssuePages(
      [issue({ status: 'Triage', updatedAt: '2026-10-10T10:00:00.000Z' })],
      [issue({ id: 'i2', identifier: 'ENG-2', updatedAt: '2026-10-10T11:00:00.000Z' })],
    );
    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 10)).resolves.toEqual({ newEvents: 2 });
    expect(db.select().from(items).all()).toMatchObject([{ linearIdentifier: 'ENG-1', category: 'triage' }]);
    expect(getCursor(db, 'linear')?.cursor).toBe('2026-10-10T11:00:00.000Z');
    expect(linear.sinceCalls).toEqual([null, null]);
  });

  it('passes the cursor on and does not double-count an issue re-delivered at the cursor time', async () => {
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    linear.sinceCalls = [];

    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 0 });
    expect(linear.sinceCalls).toEqual(['2026-10-10T10:00:00.000Z']);
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
  });

  it('catches a change that happened in the same millisecond as the cursor', async () => {
    linear.setIssuePages([issue({ status: 'Backlog' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 1 });
    expect(db.select().from(items).all()).toHaveLength(1);
  });

  it('updates the Slack item that already owns the issue', async () => {
    const slackItem = seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0', linearIssueId: 'i1', category: 'done' });
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    expect(db.select().from(items).all()).toMatchObject([{ id: slackItem.id, category: 'triage' }]);
  });
});
