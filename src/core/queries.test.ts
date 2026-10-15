import { describe, expect, it } from 'vitest';
import { recordPollError } from '@/core/cursors';
import { saveDraft } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { claimNextJob, enqueueJob, failJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { createPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { getItemDetail, getItemDetail as detailFor, getQueueStatus, listItems, prRollupsByItem } from './queries';

describe('queries', () => {
  it('lists active items newest first and dismissed items only on request', () => {
    const db = createTestDb();
    const older = seedItem(db, { updatedAt: 1 });
    const newer = seedItem(db, { updatedAt: 2 });
    const gone = seedItem(db, { category: 'dismissed' });
    expect(listItems(db).map((i) => i.id)).toEqual([newer.id, older.id]);
    expect(listItems(db, { category: 'dismissed' }).map((i) => i.id)).toEqual([gone.id]);
  });

  it('returns item detail with drafts and job activity', () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'draft_ready' });
    saveDraft(db, item.id, { title: 'T', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    enqueueJob(db, 'create-linear-issue', item.id, { issueUuid: 'uuid-1' }, 0);
    expect(getItemDetail(db, item.id)).toMatchObject({ item: { id: item.id }, drafts: [{ version: 1 }], activeJob: true });
    expect(getItemDetail(db, 999)).toBeNull();
  });

  it('summarises poll health and job counts', () => {
    const db = createTestDb();
    const item = seedItem(db);
    enqueueJob(db, 'draft', item.id, {}, 0);
    enqueueJob(db, 'draft', item.id, {}, 0);
    failJob(db, claimNextJob(db, 0)!, new PermanentError('x'), 0);
    recordPollError(db, 'linear', 'Linear server error 502', 5);
    expect(getQueueStatus(db)).toMatchObject({
      queuedJobs: 1,
      failedJobs: 1,
      polls: [{ source: 'linear', lastError: 'Linear server error 502' }],
    });
  });
});

describe('work queries', () => {
  it('includes plans, planned PRs, workspace and runs in item detail, and rolls up PRs per item', () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'implementing' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }, { repo: 'web', scope: 'y' }] }, 'claude', null, 0);
    const [first] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    updatePlannedPr(db, first!.id, { state: 'open', prNumber: 1, ciState: 'pending', unresolvedThreads: 3 }, 1);

    expect(detailFor(db, item.id)).toMatchObject({
      plans: [{ version: 1 }],
      plannedPrs: [{ position: 1, state: 'open' }, { position: 2, state: 'pending' }],
      workspace: null,
      runs: [],
      activeRun: null,
    });
    expect(prRollupsByItem(db)).toEqual({ [item.id]: { planned: 2, opened: 1, ci: 'pending', unresolved: 3 } });
  });
});
