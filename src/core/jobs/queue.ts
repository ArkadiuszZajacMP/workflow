import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { AGENT_JOB_TYPES, type Job, type JobType, jobs, type TriageState, type WorkState } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';
import { getItem, logActivity, markItemFailed, updateItem } from '../items';
import { writeTransaction } from '../db/tx';
import { updatePlannedPr } from '../work/planned-prs';
import { markWorkFailed } from '../work/state';
import { updateWorkspace } from '../work/workspaces';

export type JobPayloads = {
  'triage-draft': Record<string, never>;
  draft: { feedback?: string };
  /** Client-generated Linear issue id. A retry reuses it, so a lost create response can never create a second issue. */
  'create-linear-issue': { issueUuid: string };
  'link-linear-issue': { identifier: string; issueId?: string };
  investigate: { feedback?: string };
  /** Client-generated Linear comment id, so a retried post never creates a second comment. */
  'post-plan': { commentUuid: string };
  'implement-pr': { plannedPrId: number };
  'fix-pr': { plannedPrId: number };
  'remove-workspace': Record<string, never>;
};

export type JobStartState = { triage: TriageState | null; work: WorkState | null };

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

export function claimNextJob(db: Db, now = Date.now(), types?: readonly JobType[]): Job | null {
  return writeTransaction(db, (tx) => {
    const due = and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now));
    const next = tx
      .select()
      .from(jobs)
      .where(types ? and(due, inArray(jobs.type, [...types])) : due)
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
      .set({
        status: 'queued',
        runAfter: now + backoffMs(job.attempts, retryAfter),
        lastError: message,
        stopRequested: false,
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .run();
    return 'rescheduled';
  }
  db.update(jobs).set({ status: 'failed', lastError: message, updatedAt: now }).where(eq(jobs.id, job.id)).run();
  return 'failed';
}

/**
 * Records on the item that `job` failed for good.
 * - Link and fix jobs start from states where the user is choosing, so they keep that state.
 * - Work jobs fail the work state.
 * - Triage jobs fail the triage state.
 */
export function recordJobFailure(db: Db, job: Job, start: JobStartState, message: string, now = Date.now()): void {
  switch (job.type) {
    case 'link-linear-issue': {
      const { identifier } = jobPayload(job as Job & { type: 'link-linear-issue' });
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Link to ${identifier} failed: ${message}`, now);
      return;
    }
    case 'fix-pr': {
      const { plannedPrId } = jobPayload(job as Job & { type: 'fix-pr' });
      updatePlannedPr(db, plannedPrId, { lastError: message }, now);
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Fix round failed: ${message}`, now);
      return;
    }
    case 'remove-workspace':
      updateWorkspace(db, job.itemId, { status: 'broken' }, now);
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Removing the workspace failed: ${message}`, now);
      return;
    case 'implement-pr': {
      const { plannedPrId } = jobPayload(job as Job & { type: 'implement-pr' });
      updatePlannedPr(db, plannedPrId, { state: 'failed', lastError: message }, now);
      markWorkFailed(db, job.itemId, start.work, message, now);
      return;
    }
    case 'investigate':
    case 'post-plan':
      markWorkFailed(db, job.itemId, start.work, message, now);
      return;
    default:
      markItemFailed(db, job.itemId, start.triage, message, now);
  }
}

export const CRASHED_MESSAGE = 'Worker crashed while running this job';

/**
 * Single worker: anything still `running` when the worker starts was orphaned by a crash.
 * Jobs with attempts left are requeued. Jobs out of attempts fail, so a job that crashes the
 * worker every time cannot loop forever.
 */
export function recoverRunningJobs(db: Db, now = Date.now()): { requeued: number; failed: number } {
  return writeTransaction(db, (tx) => {
    const exhausted = tx
      .update(jobs)
      .set({ status: 'failed', lastError: CRASHED_MESSAGE, updatedAt: now })
      .where(and(eq(jobs.status, 'running'), gte(jobs.attempts, MAX_ATTEMPTS)))
      .returning()
      .all();
    for (const job of exhausted) {
      const item = getItem(tx, job.itemId);
      recordJobFailure(tx, job, { triage: item?.triageState ?? null, work: item?.workState ?? null }, CRASHED_MESSAGE, now);
    }
    const requeued = tx
      .update(jobs)
      .set({ status: 'queued', runAfter: now, stopRequested: false, updatedAt: now })
      .where(and(eq(jobs.status, 'running'), lt(jobs.attempts, MAX_ATTEMPTS)))
      .returning({ id: jobs.id })
      .all().length;
    return { requeued, failed: exhausted.length };
  });
}

export function hasActiveJob(db: Db, itemId: number): boolean {
  const row = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), inArray(jobs.status, ['queued', 'running'])))
    .get();
  return row !== undefined;
}

/** True when a queued or running job of this type for the item has a payload accepted by `match`. */
export function hasActiveJobFor<T extends JobType>(
  db: Db,
  type: T,
  itemId: number,
  match: (payload: JobPayloads[T]) => boolean,
): boolean {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.type, type), inArray(jobs.status, ['queued', 'running'])))
    .all()
    .some((j) => match(j.payload as JobPayloads[T]));
}

export function latestFailedJob(db: Db, itemId: number, types?: readonly JobType[]): Job | undefined {
  const failed = and(eq(jobs.itemId, itemId), eq(jobs.status, 'failed'));
  return db
    .select()
    .from(jobs)
    .where(types ? and(failed, inArray(jobs.type, [...types])) : failed)
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .get();
}

export function runningAgentJob(db: Db, itemId: number): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.status, 'running'), inArray(jobs.type, [...AGENT_JOB_TYPES])))
    .get();
}

export function requestStop(db: Db, jobId: number): void {
  db.update(jobs).set({ stopRequested: true }).where(eq(jobs.id, jobId)).run();
}

/** Asks the item's running agent job, if any, to stop. Returns that job. */
export function requestAgentStop(db: Db, itemId: number): Job | undefined {
  const job = runningAgentJob(db, itemId);
  if (job) requestStop(db, job.id);
  return job;
}

export function isStopRequested(db: Db, jobId: number): boolean {
  return db.select({ stop: jobs.stopRequested }).from(jobs).where(eq(jobs.id, jobId)).get()?.stop ?? false;
}

/** Puts a job interrupted by worker shutdown back in the queue and refunds the attempt its claim consumed. */
export function requeueAfterShutdown(db: Db, job: Job, now = Date.now()): void {
  db.update(jobs)
    .set({ status: 'queued', attempts: Math.max(0, job.attempts - 1), runAfter: now, stopRequested: false, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
}

export function requeueJob(db: Db, jobId: number, now = Date.now()): void {
  db.update(jobs)
    .set({ status: 'queued', attempts: 0, runAfter: now, lastError: null, stopRequested: false, updatedAt: now })
    .where(eq(jobs.id, jobId))
    .run();
}
