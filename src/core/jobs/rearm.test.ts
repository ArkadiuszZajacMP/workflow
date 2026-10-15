import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { type Item, jobs } from '@/core/db/schema';
import { getItem, listActivity } from '@/core/items';
import { createPlannedPrs, getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { claimNextJob, completeJob, enqueueJob } from './queue';
import { rearmStrandedJob } from './rearm';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});
const queued = () => db.select().from(jobs).all().filter((j) => j.status === 'queued');
const dismissed = (workState: Item['workState']) =>
  seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', category: 'dismissed', workState });
const finish = () => completeJob(db, claimNextJob(db, 1)!.id, 2);

function withPrs(states: Array<'open' | 'failed' | 'implementing'>) {
  const item = dismissed('implementing');
  const plan = savePlan(
    db,
    item.id,
    { body: 'b', breakdown: states.map((_, i) => ({ repo: i % 2 ? 'web' : 'core', scope: `Scope ${i}` })) },
    'user',
    null,
    1,
  );
  const prs = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 1);
  prs.forEach((pr, i) => updatePlannedPr(db, pr.id, { state: states[i]!, ...(states[i] === 'open' ? { prNumber: 10 + i } : {}) }, 2));
  return { item, prs };
}

describe('rearmStrandedJob work states', () => {
  it('re-arms investigating with the previous feedback', () => {
    const item = dismissed('investigating');
    enqueueJob(db, 'investigate', item.id, { feedback: 'x' }, 1);
    finish();
    rearmStrandedJob(db, item, 5);
    expect(queued()).toMatchObject([{ type: 'investigate', payload: { feedback: 'x' } }]);
  });

  it('re-arms posting_plan with the same comment UUID', () => {
    const item = dismissed('posting_plan');
    enqueueJob(db, 'post-plan', item.id, { commentUuid: 'U-1' }, 1);
    finish();
    rearmStrandedJob(db, item, 5);
    expect(queued()).toMatchObject([{ type: 'post-plan', payload: { commentUuid: 'U-1' } }]);
  });

  it('re-arms implementing for the first failed PR and resets it', () => {
    const { item, prs } = withPrs(['open', 'failed']);
    rearmStrandedJob(db, item, 5);
    expect(queued()).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[1]!.id } }]);
    expect(getPlannedPr(db, prs[1]!.id)?.state).toBe('pending');
  });

  it('re-arms implementing for a PR left in the implementing state', () => {
    const { item, prs } = withPrs(['open', 'implementing']);
    rearmStrandedJob(db, item, 5);
    expect(queued()).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[1]!.id } }]);
    expect(getPlannedPr(db, prs[1]!.id)?.state).toBe('pending');
  });

  it('finishes implementation instead of enqueueing when every PR is open', () => {
    const { item } = withPrs(['open', 'open']);
    expect(rearmStrandedJob(db, item, 5)).toBeNull();
    expect(queued()).toEqual([]);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', category: 'verification' });
    expect(listActivity(db, item.id).at(-1)?.message).toBe('All planned PRs are open; moved to Verification');
  });

  it('enqueues nothing when a job is already active', () => {
    const item = dismissed('investigating');
    enqueueJob(db, 'investigate', item.id, {}, 1);
    expect(rearmStrandedJob(db, getItem(db, item.id)!, 5)).toBeNull();
    expect(queued()).toHaveLength(1);
  });
});
