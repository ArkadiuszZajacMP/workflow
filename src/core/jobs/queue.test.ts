import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem } from '@/core/items';
import { createPlannedPrs, getPlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import {
  backoffMs,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  hasActiveJob,
  isStopRequested,
  latestFailedJob,
  MAX_ATTEMPTS,
  recordJobFailure,
  recoverRunningJobs,
  requestStop,
  requeueJob,
  runningAgentJob,
} from './queue';

let db: Db;
let itemId: number;

beforeEach(() => {
  db = createTestDb();
  itemId = seedItem(db).id;
});

const getJob = (id: number) => db.select().from(jobs).where(eq(jobs.id, id)).get()!;

describe('backoffMs', () => {
  it('uses 30s, 2m, 10m and honours a longer Retry-After', () => {
    expect([backoffMs(1), backoffMs(2), backoffMs(3)]).toEqual([30_000, 120_000, 600_000]);
    expect(backoffMs(1, 90_000)).toBe(90_000);
    expect(backoffMs(2, 5_000)).toBe(120_000);
  });
});

describe('claimNextJob', () => {
  it('returns null when nothing is due', () => {
    enqueueJob(db, 'draft', itemId, {}, 5_000);
    expect(claimNextJob(db, 4_999)).toBeNull();
  });

  it('claims the oldest due job, marks it running and counts the attempt', () => {
    const first = enqueueJob(db, 'triage-draft', itemId, {}, 1_000);
    enqueueJob(db, 'draft', itemId, {}, 2_000);
    const claimed = claimNextJob(db, 3_000);
    expect(claimed).toMatchObject({ id: first.id, status: 'running', attempts: 1, startedAt: 3_000 });
    expect(claimNextJob(db, 3_000)?.type).toBe('draft');
    expect(claimNextJob(db, 3_000)).toBeNull();
  });
});

describe('failJob', () => {
  it('reschedules transient errors with backoff until attempts run out', () => {
    const job = enqueueJob(db, 'draft', itemId, {}, 0);

    const a1 = claimNextJob(db, 0)!;
    expect(failJob(db, a1, new TransientError('timeout'), 0)).toBe('rescheduled');
    expect(getJob(job.id)).toMatchObject({ status: 'queued', runAfter: 30_000, lastError: 'timeout' });

    const a2 = claimNextJob(db, 30_000)!;
    expect(failJob(db, a2, new Error('socket hang up'), 30_000)).toBe('rescheduled');
    expect(getJob(job.id).runAfter).toBe(150_000);

    const a3 = claimNextJob(db, 150_000)!;
    expect(failJob(db, a3, new TransientError('timeout'), 150_000)).toBe('failed');
    expect(getJob(job.id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('fails permanent errors immediately', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    expect(failJob(db, claimed, new PermanentError('bad output'), 0)).toBe('failed');
    expect(getJob(claimed.id)).toMatchObject({ status: 'failed', lastError: 'bad output' });
  });

  it('respects Retry-After from a rate limit', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new TransientError('rate limited', 300_000), 0);
    expect(getJob(claimed.id).runAfter).toBe(300_000);
  });
});

describe('job bookkeeping', () => {
  it('tracks active jobs per item', () => {
    expect(hasActiveJob(db, itemId)).toBe(false);
    const job = enqueueJob(db, 'draft', itemId, {}, 0);
    expect(hasActiveJob(db, itemId)).toBe(true);
    claimNextJob(db, 0);
    expect(hasActiveJob(db, itemId)).toBe(true);
    completeJob(db, job.id, 1);
    expect(hasActiveJob(db, itemId)).toBe(false);
  });

  it('recovers running jobs after a crash', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    expect(recoverRunningJobs(db, 10)).toEqual({ requeued: 1, failed: 0 });
    expect(getJob(claimed.id)).toMatchObject({ status: 'queued', runAfter: 10 });
  });

  it('fails a crashed job that is out of attempts, and its item, instead of requeueing it forever', () => {
    const drafting = seedItem(db, { triageState: 'drafting', slackChannel: 'C9', slackThreadTs: '9.0' });
    const exhausted = enqueueJob(db, 'draft', drafting.id, {}, 0);
    const other = enqueueJob(db, 'triage-draft', itemId, {}, 0);
    db.update(jobs).set({ status: 'running', attempts: MAX_ATTEMPTS }).where(eq(jobs.id, exhausted.id)).run();
    db.update(jobs).set({ status: 'running', attempts: 1 }).where(eq(jobs.id, other.id)).run();

    expect(recoverRunningJobs(db, 10)).toEqual({ requeued: 1, failed: 1 });
    expect(getJob(exhausted.id)).toMatchObject({ status: 'failed', lastError: 'Worker crashed while running this job' });
    expect(getJob(other.id)).toMatchObject({ status: 'queued', runAfter: 10 });
    expect(getItem(db, drafting.id)).toMatchObject({
      triageState: 'failed',
      failedFromState: 'drafting',
      lastError: 'Worker crashed while running this job',
    });
  });

  it('requeues the latest failed job with a fresh attempt budget', () => {
    enqueueJob(db, 'create-linear-issue', itemId, { issueUuid: 'uuid-1' }, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new PermanentError('boom'), 0);
    const failed = latestFailedJob(db, itemId)!;
    expect(failed.id).toBe(claimed.id);
    requeueJob(db, failed.id, 50);
    expect(getJob(failed.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: 50, lastError: null, payload: { issueUuid: 'uuid-1' } });
  });
});

describe('typed claims and failure routing', () => {
  it('claims only the requested job types', () => {
    enqueueJob(db, 'investigate', itemId, {}, 0);
    const draft = enqueueJob(db, 'draft', itemId, {}, 1);
    expect(claimNextJob(db, 5, ['draft'])?.id).toBe(draft.id);
    expect(claimNextJob(db, 5, ['draft'])).toBeNull();
    expect(claimNextJob(db, 5, ['investigate'])?.type).toBe('investigate');
  });

  it('fails work for investigate jobs and keeps triage untouched', () => {
    const item = seedItem(db, { workState: 'investigating', triageState: 'linked' });
    const job = enqueueJob(db, 'investigate', item.id, {}, 0);
    recordJobFailure(db, job, { triage: 'linked', work: 'investigating' }, 'boom', 1);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'failed', workFailedFromState: 'investigating', triageState: 'linked' });
  });

  it('marks the planned PR failed for implement-pr', () => {
    const item = seedItem(db, { workState: 'implementing', linearIdentifier: 'BOO-1', linearIssueId: 'i1' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
    const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    const job = enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr!.id }, 0);
    recordJobFailure(db, job, { triage: null, work: 'implementing' }, 'push rejected', 1);
    expect(getPlannedPr(db, pr!.id)).toMatchObject({ state: 'failed', lastError: 'push rejected' });
    expect(getItem(db, item.id)?.workState).toBe('failed');
  });

  it('keeps the work state when a fix round fails', () => {
    const item = seedItem(db, { workState: 'prs_open', linearIdentifier: 'BOO-1', linearIssueId: 'i1' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
    const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    const job = enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr!.id }, 0);
    recordJobFailure(db, job, { triage: null, work: 'prs_open' }, 'timed out', 1);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', lastError: 'timed out' });
    expect(getPlannedPr(db, pr!.id)?.lastError).toBe('timed out');
  });

  it('finds the latest failed job of given types', () => {
    const job = enqueueJob(db, 'investigate', itemId, {}, 0);
    failJob(db, claimNextJob(db, 0)!, new PermanentError('x'), 0);
    enqueueJob(db, 'draft', itemId, {}, 1);
    failJob(db, claimNextJob(db, 1)!, new PermanentError('y'), 2);
    expect(latestFailedJob(db, itemId, ['investigate'])?.id).toBe(job.id);
  });

  it('flags a running agent job for stopping', () => {
    const job = enqueueJob(db, 'implement-pr', itemId, { plannedPrId: 1 }, 0);
    expect(runningAgentJob(db, itemId)).toBeUndefined();
    claimNextJob(db, 0);
    expect(runningAgentJob(db, itemId)?.id).toBe(job.id);
    expect(isStopRequested(db, job.id)).toBe(false);
    requestStop(db, job.id);
    expect(isStopRequested(db, job.id)).toBe(true);
  });
});

describe('stop requests are cleared when a job is requeued', () => {
  const claimStopped = () => {
    const job = enqueueJob(db, 'implement-pr', itemId, { plannedPrId: 1 }, 0);
    claimNextJob(db, 0);
    requestStop(db, job.id);
    expect(isStopRequested(db, job.id)).toBe(true);
    return job;
  };

  it('on crash recovery', () => {
    const job = claimStopped();
    recoverRunningJobs(db, 10);
    expect(getJob(job.id).status).toBe('queued');
    expect(isStopRequested(db, job.id)).toBe(false);
  });

  it('on a transient reschedule', () => {
    const job = claimStopped();
    expect(failJob(db, getJob(job.id), new TransientError('busy'), 10)).toBe('rescheduled');
    expect(getJob(job.id).status).toBe('queued');
    expect(isStopRequested(db, job.id)).toBe(false);
  });

  it('on requeueJob', () => {
    const job = claimStopped();
    requeueJob(db, job.id, 10);
    expect(isStopRequested(db, job.id)).toBe(false);
  });
});
