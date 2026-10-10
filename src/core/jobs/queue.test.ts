import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import {
  backoffMs,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  hasActiveJob,
  latestFailedJob,
  recoverRunningJobs,
  requeueJob,
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
    expect(recoverRunningJobs(db, 10)).toBe(1);
    expect(getJob(claimed.id)).toMatchObject({ status: 'queued', runAfter: 10 });
  });

  it('requeues the latest failed job with a fresh attempt budget', () => {
    enqueueJob(db, 'create-linear-issue', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new PermanentError('boom'), 0);
    const failed = latestFailedJob(db, itemId)!;
    expect(failed.id).toBe(claimed.id);
    requeueJob(db, failed.id, 50);
    expect(getJob(failed.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: 50, lastError: null });
  });
});
