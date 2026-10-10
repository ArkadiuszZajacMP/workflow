import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { latestDraft, listDuplicateCandidates, saveDraft } from '@/core/drafts';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { draftHandler } from './draft';
import { triageDraftHandler } from './triage-draft';
import type { HandlerContext } from './types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
let db: Db;
let ctx: HandlerContext;
let slack: FakeSlack;
let linear: FakeLinear;
let claude: FakeClaude;

beforeEach(() => {
  db = createTestDb();
  slack = new FakeSlack();
  linear = new FakeLinear();
  claude = new FakeClaude();
  ctx = { db, config: TEST_CONFIG, slack, linear, claude, now: () => NOW };
  slack.threads.set('C1:1.0', [
    { ts: '1.0', userName: 'ana', text: 'CSV export returns 500\nfor big workspaces', files: [] },
  ]);
});

function newTriageItem() {
  const item = seedItem(db, { triageState: 'new', slackChannel: 'C1', slackThreadTs: '1.0', title: '' });
  enqueueJob(db, 'triage-draft', item.id, {}, 0);
  return { item, job: claimNextJob(db, 0)! };
}

const candidate = (identifier: string, closedAt: string | null = null) => ({
  id: `id-${identifier}`, identifier, title: 'CSV export 500', url: `u/${identifier}`,
  status: 'Todo', description: 'Export fails', closedAt,
});

describe('triageDraftHandler', () => {
  it('goes straight to drafting when Linear has no candidates', async () => {
    const { item, job } = newTriageItem();
    claude.respond('search-terms', { queries: ['csv export 500'] });
    await triageDraftHandler(ctx, job);

    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'drafting',
      title: 'CSV export returns 500',
      slackPermalink: 'https://slack.test/archives/C1/p10',
      slackThread: [{ userName: 'ana' }],
    });
    expect(claude.calls.map((c) => c.name)).toEqual(['search-terms']);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toMatchObject([{ type: 'draft' }]);
  });

  it('stops at duplicate_suspected when a candidate meets the threshold', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-7'), candidate('ENG-8')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    claude.respond('assess-duplicates', {
      duplicates: [
        { identifier: 'ENG-7', confidence: 0.92, reasoning: 'Same 500 on export' },
        { identifier: 'ENG-8', confidence: 0.5, reasoning: 'Related' },
        { identifier: 'ENG-999', confidence: 0.99, reasoning: 'Invented' },
      ],
    });
    await triageDraftHandler(ctx, job);

    expect(getItem(db, item.id)?.triageState).toBe('duplicate_suspected');
    expect(listDuplicateCandidates(db, item.id)).toMatchObject([{ linearIdentifier: 'ENG-7', confidence: 0.92 }]);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toHaveLength(0);
  });

  it('drafts when all candidates are weak', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-8')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    claude.respond('assess-duplicates', { duplicates: [{ identifier: 'ENG-8', confidence: 0.4, reasoning: 'r' }] });
    await triageDraftHandler(ctx, job);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });

  it('ignores issues closed longer ago than searchClosedWithinDays', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-1', '2026-01-01T00:00:00.000Z')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    await triageDraftHandler(ctx, job);
    expect(claude.calls.map((c) => c.name)).toEqual(['search-terms']);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });

  it('does nothing for a dismissed item', async () => {
    const { item, job } = newTriageItem();
    updateItem(db, item.id, { category: 'dismissed' });
    await triageDraftHandler(ctx, job);
    expect(claude.calls).toEqual([]);
    expect(getItem(db, item.id)?.triageState).toBe('new');
  });

  it('stops if the item is dismissed while Claude is working', async () => {
    const { item, job } = newTriageItem();
    claude.run = async () => {
      updateItem(db, item.id, { category: 'dismissed' });
      return { queries: ['csv export 500'] } as never;
    };
    await triageDraftHandler(ctx, job);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toHaveLength(0);
    expect(getItem(db, item.id)?.triageState).toBe('checking_duplicates');
    expect(listDuplicateCandidates(db, item.id)).toEqual([]);
  });

  it('stops if the item is dismissed during the Slack call', async () => {
    const { item, job } = newTriageItem();
    const thread = slack.threads.get('C1:1.0')!;
    slack.getThread = async () => {
      updateItem(db, item.id, { category: 'dismissed' });
      return thread;
    };
    await triageDraftHandler(ctx, job);
    expect(claude.calls).toEqual([]);
    expect(getItem(db, item.id)).toMatchObject({ slackPermalink: null, slackThread: null, title: '' });
  });

  it('does nothing for an item that is not in a triage-draft state', async () => {
    const item = seedItem(db, { triageState: 'drafting', slackChannel: 'C1', slackThreadTs: '1.0' });
    enqueueJob(db, 'triage-draft', item.id, {}, 0);
    await triageDraftHandler(ctx, claimNextJob(db, 0)!);
    expect(claude.calls).toEqual([]);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });

  it('completes a retried job for an item already in checking_duplicates', async () => {
    const item = seedItem(db, { triageState: 'checking_duplicates', slackChannel: 'C1', slackThreadTs: '1.0', title: '' });
    enqueueJob(db, 'triage-draft', item.id, {}, 0);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    await triageDraftHandler(ctx, claimNextJob(db, 0)!);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });
});

describe('draftHandler', () => {
  it('saves a Claude draft and moves to draft_ready', async () => {
    const item = seedItem(db, {
      triageState: 'drafting',
      slackThread: [{ ts: '1.0', userName: 'ana', text: 'CSV export returns 500', files: [] }],
    });
    enqueueJob(db, 'draft', item.id, {}, 0);
    claude.respond('draft', { title: 'CSV export returns 500', problem: 'Export fails.', acceptanceCriteria: ['Export works'] });
    await draftHandler(ctx, claimNextJob(db, 0)!);

    expect(getItem(db, item.id)?.triageState).toBe('draft_ready');
    expect(latestDraft(db, item.id)).toMatchObject({ version: 1, author: 'claude', title: 'CSV export returns 500' });
    expect(claude.calls[0]?.vars).toMatchObject({ previousDraft: '(none)', feedback: '(none)' });
  });

  it('passes the previous draft and feedback when revising', async () => {
    const item = seedItem(db, { triageState: 'drafting', slackThread: [] });
    saveDraft(db, item.id, { title: 'Old', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    enqueueJob(db, 'draft', item.id, { feedback: 'focus on mobile' }, 0);
    claude.respond('draft', { title: 'New', problem: 'P2', acceptanceCriteria: ['A2'] });
    await draftHandler(ctx, claimNextJob(db, 0)!);

    expect(claude.calls[0]?.vars).toMatchObject({ feedback: 'focus on mobile', previousDraft: expect.stringContaining('Title: Old') });
    expect(latestDraft(db, item.id)).toMatchObject({ version: 2, feedback: 'focus on mobile' });
  });
});
