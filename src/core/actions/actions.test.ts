import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { latestDraft, saveDraft } from '@/core/drafts';
import { ActionError, PermanentError } from '@/core/errors';
import { getItem, markItemFailed } from '@/core/items';
import { claimNextJob, enqueueJob, failJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { approve, discard, editDraft, link, move, notDuplicate, retry, revise } from './index';

const content = { title: 'Export fails', problem: 'CSV export returns 500.', acceptanceCriteria: ['Export succeeds'] };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const allJobs = () => db.select().from(jobs).all();

function draftReadyItem() {
  const item = seedItem(db, { triageState: 'draft_ready', slackChannel: 'C1', slackThreadTs: '1.0' });
  saveDraft(db, item.id, content, 'claude', null, 1);
  return item;
}

describe('approve', () => {
  it('moves to creating_issue and enqueues one create job, even when clicked twice', () => {
    const item = draftReadyItem();
    expect(approve(db, item.id, 5).triageState).toBe('creating_issue');
    expect(() => approve(db, item.id, 6)).toThrow(ActionError);
    expect(allJobs()).toMatchObject([{ type: 'create-linear-issue', itemId: item.id }]);
  });

  it('stores a fresh issue UUID in the create job payload', () => {
    const item = draftReadyItem();
    approve(db, item.id, 5);
    const uuid = (allJobs()[0]?.payload as { issueUuid?: string }).issueUuid;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('requires a draft', () => {
    const item = seedItem(db, { triageState: 'draft_ready' });
    expect(() => approve(db, item.id)).toThrow(/no draft/);
  });
});

describe('link', () => {
  it('enqueues a link job from duplicate_suspected and rejects a second click', () => {
    const item = seedItem(db, { triageState: 'duplicate_suspected' });
    link(db, item.id, { identifier: 'eng-12', issueId: 'i12' }, 5);
    expect(() => link(db, item.id, { identifier: 'ENG-12' }, 6)).toThrow(/already has a job/);
    expect(allJobs()).toMatchObject([{ type: 'link-linear-issue', payload: { identifier: 'ENG-12', issueId: 'i12' } }]);
  });

  it('validates the identifier and the state', () => {
    const ready = draftReadyItem();
    expect(() => link(db, ready.id, { identifier: 'not an id' })).toThrow(/identifier/);
    const drafting = seedItem(db, { triageState: 'drafting' });
    expect(() => link(db, drafting.id, { identifier: 'ENG-1' })).toThrow(ActionError);
  });
});

describe('notDuplicate and revise', () => {
  it('starts a fresh draft after rejecting duplicates', () => {
    const item = seedItem(db, { triageState: 'duplicate_suspected' });
    expect(notDuplicate(db, item.id).triageState).toBe('drafting');
    expect(allJobs()).toMatchObject([{ type: 'draft', payload: {} }]);
  });

  it('passes feedback to the draft job and refuses empty feedback', () => {
    const item = draftReadyItem();
    expect(() => revise(db, item.id, '   ')).toThrow(/feedback/);
    expect(revise(db, item.id, ' focus on mobile ').triageState).toBe('drafting');
    expect(allJobs()).toMatchObject([{ type: 'draft', payload: { feedback: 'focus on mobile' } }]);
  });
});

describe('editDraft', () => {
  it('saves a user version and drops blank criteria', () => {
    const item = draftReadyItem();
    editDraft(db, item.id, { title: ' New title ', problem: 'p', acceptanceCriteria: ['a', '  ', 'b'] }, 5);
    expect(latestDraft(db, item.id)).toMatchObject({
      version: 2, author: 'user', title: 'New title', acceptanceCriteria: ['a', 'b'],
    });
  });

  it('rejects empty content and wrong states', () => {
    const item = draftReadyItem();
    expect(() => editDraft(db, item.id, { ...content, acceptanceCriteria: [' '] })).toThrow(/acceptance criterion/);
    expect(() => editDraft(db, item.id, { ...content, title: '' })).toThrow(/title/);
    const drafting = seedItem(db, { triageState: 'drafting' });
    expect(() => editDraft(db, drafting.id, content)).toThrow(ActionError);
  });
});

describe('discard and move', () => {
  it('dismisses an item once', () => {
    const item = draftReadyItem();
    expect(discard(db, item.id).category).toBe('dismissed');
    expect(() => discard(db, item.id)).toThrow(/already dismissed/);
  });

  it('moves between categories and rejects unknown ones', () => {
    const item = seedItem(db);
    expect(move(db, item.id, 'in_progress').category).toBe('in_progress');
    expect(() => move(db, item.id, 'archived' as never)).toThrow(/Unknown category/);
  });
});

describe('retry', () => {
  it('restores the failed-from state and requeues the failed job', () => {
    const item = seedItem(db, { triageState: 'creating_issue' });
    enqueueJob(db, 'create-linear-issue', item.id, { issueUuid: 'uuid-1' }, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new PermanentError('Linear API error: team not found'), 0);
    markItemFailed(db, item.id, 'creating_issue', 'Linear API error: team not found', 0);

    expect(retry(db, item.id, 10)).toMatchObject({ triageState: 'creating_issue', lastError: null, failedFromState: null });
    expect(allJobs()).toMatchObject([{ id: claimed.id, status: 'queued', attempts: 0 }]);
  });

  it('refuses to retry items that have not failed', () => {
    const item = draftReadyItem();
    expect(() => retry(db, item.id)).toThrow(ActionError);
    expect(getItem(db, item.id)?.triageState).toBe('draft_ready');
  });
});
