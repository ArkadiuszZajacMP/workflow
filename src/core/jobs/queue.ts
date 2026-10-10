import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Job, type JobType, jobs } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';

export type JobPayloads = {
  'triage-draft': Record<string, never>;
  draft: { feedback?: string };
  'create-linear-issue': Record<string, never>;
  'link-linear-issue': { identifier: string; issueId?: string };
};

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 120_000, 600_000];

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return Math.max(BACKOFF_MS[index]!, retryAfterMs ?? 0);
}

export function enqueueJob<T extends JobType>(
  db: Db,
  type: T,
  itemId: number,
  payload: JobPayloads[T],
  now = Date.now(),
): Job {
  return db
    .insert(jobs)
    .values({ type, itemId, payload, status: 'queued', attempts: 0, runAfter: now, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function jobPayload<T extends JobType>(job: Job & { type: T }): JobPayloads[T] {
  return job.payload as JobPayloads[T];
}

export function claimNextJob(db: Db, now = Date.now()): Job | null {
  return db.transaction((tx) => {
    const next = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.runAfter), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return null;
    return tx
      .update(jobs)
      .set({ status: 'running', attempts: next.attempts + 1, startedAt: now, updatedAt: now })
      .where(eq(jobs.id, next.id))
      .returning()
      .get();
  });
}

export function completeJob(db: Db, jobId: number, now = Date.now()): void {
  db.update(jobs).set({ status: 'done', lastError: null, updatedAt: now }).where(eq(jobs.id, jobId)).run();
}

export function failJob(db: Db, job: Job, err: unknown, now = Date.now()): 'rescheduled' | 'failed' {
  const message = errorMessage(err);
  const transient = !(err instanceof PermanentError);
  if (transient && job.attempts < MAX_ATTEMPTS) {
    const retryAfter = err instanceof TransientError ? err.retryAfterMs : undefined;
    db.update(jobs)
      .set({ status: 'queued', runAfter: now + backoffMs(job.attempts, retryAfter), lastError: message, updatedAt: now })
      .where(eq(jobs.id, job.id))
      .run();
    return 'rescheduled';
  }
  db.update(jobs).set({ status: 'failed', lastError: message, updatedAt: now }).where(eq(jobs.id, job.id)).run();
  return 'failed';
}

/** Single worker: anything still `running` when the worker starts was orphaned by a crash. */
export function recoverRunningJobs(db: Db, now = Date.now()): number {
  return db
    .update(jobs)
    .set({ status: 'queued', runAfter: now, updatedAt: now })
    .where(eq(jobs.status, 'running'))
    .returning({ id: jobs.id })
    .all().length;
}

export function hasActiveJob(db: Db, itemId: number): boolean {
  const row = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), inArray(jobs.status, ['queued', 'running'])))
    .get();
  return row !== undefined;
}

export function latestFailedJob(db: Db, itemId: number): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.status, 'failed')))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .get();
}

export function requeueJob(db: Db, jobId: number, now = Date.now()): void {
  db.update(jobs)
    .set({ status: 'queued', attempts: 0, runAfter: now, lastError: null, updatedAt: now })
    .where(eq(jobs.id, jobId))
    .run();
}
