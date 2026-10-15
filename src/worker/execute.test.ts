import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '@/core/db/schema';
import { ShutdownStop } from '@/core/errors';
import { claimNextJob, enqueueJob, requestStop } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { executeJob } from './execute';

describe('executeJob', () => {
  it('requeues a job interrupted by shutdown without consuming an attempt', async () => {
    const db = createTestDb();
    const job = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    await executeJob(db, claimed, () => Promise.reject(new ShutdownStop()), () => 5);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('fails the job as stopped when a user Stop is pending at shutdown', async () => {
    const db = createTestDb();
    const job = enqueueJob(db, 'investigate', seedItem(db).id, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    requestStop(db, job.id);
    await executeJob(db, claimed, () => Promise.reject(new ShutdownStop()), () => 5);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()).toMatchObject({
      status: 'failed',
      lastError: 'Run stopped by user',
    });
  });
});
