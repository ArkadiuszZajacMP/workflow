import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Item, type Job, type JobType, jobs, type TriageState } from '../db/schema';
import { enqueueJob, hasActiveJob, type JobPayloads } from './queue';

/** The job that moves an item on from each job-driven triage state. */
const JOB_FOR_STATE: Partial<Record<TriageState, JobType>> = {
  new: 'triage-draft',
  checking_duplicates: 'triage-draft',
  drafting: 'draft',
  creating_issue: 'create-linear-issue',
};

function latestJobOfType(db: Db, itemId: number, type: JobType): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.type, type)))
    .orderBy(desc(jobs.id))
    .get();
}

/**
 * Handlers skip dismissed items, so an item dismissed in a job-driven state is left with no job.
 * When it comes back, enqueue the job for its state again. The previous job's payload is reused,
 * so a create job keeps its issue UUID (and a draft job its feedback).
 */
export function rearmStrandedJob(db: Db, item: Item, now = Date.now()): Job | null {
  const type = item.triageState ? JOB_FOR_STATE[item.triageState] : undefined;
  if (!type || hasActiveJob(db, item.id)) return null;
  const previous = latestJobOfType(db, item.id, type)?.payload as Record<string, unknown> | undefined;
  if (type === 'create-linear-issue') {
    const issueUuid = typeof previous?.issueUuid === 'string' ? previous.issueUuid : randomUUID();
    return enqueueJob(db, type, item.id, { issueUuid }, now);
  }
  return enqueueJob(db, type, item.id, (previous ?? {}) as JobPayloads[typeof type], now);
}
