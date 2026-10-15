import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Item, type Job, type JobType, jobs, type TriageState, type WorkState } from '../db/schema';
import { firstUnfinishedPr, updatePlannedPr } from '../work/planned-prs';
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

const JOB_FOR_WORK_STATE: Partial<Record<WorkState, JobType>> = {
  investigating: 'investigate',
  posting_plan: 'post-plan',
  implementing: 'implement-pr',
};

/**
 * Handlers skip dismissed items, so an item dismissed in a job-driven state is left with no job.
 * When it comes back, enqueue the job for its state again. The previous job's payload is reused,
 * so a create job keeps its issue UUID, a post-plan job its comment UUID, and a draft or
 * investigate job its feedback.
 */
export function rearmStrandedJob(db: Db, item: Item, now = Date.now()): Job | null {
  if (hasActiveJob(db, item.id)) return null;
  const triageType = item.triageState ? JOB_FOR_STATE[item.triageState] : undefined;
  if (triageType) {
    const previous = latestJobOfType(db, item.id, triageType)?.payload as Record<string, unknown> | undefined;
    if (triageType === 'create-linear-issue') {
      const issueUuid = typeof previous?.issueUuid === 'string' ? previous.issueUuid : randomUUID();
      return enqueueJob(db, triageType, item.id, { issueUuid }, now);
    }
    return enqueueJob(db, triageType, item.id, (previous ?? {}) as JobPayloads[typeof triageType], now);
  }
  const workType = item.workState ? JOB_FOR_WORK_STATE[item.workState] : undefined;
  if (!workType) return null;
  if (workType === 'implement-pr') {
    const pr = firstUnfinishedPr(db, item.id);
    if (!pr) return null;
    if (pr.state !== 'pending') updatePlannedPr(db, pr.id, { state: 'pending' }, now);
    return enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr.id }, now);
  }
  const previous = latestJobOfType(db, item.id, workType)?.payload as Record<string, unknown> | undefined;
  if (workType === 'post-plan') {
    const commentUuid = typeof previous?.commentUuid === 'string' ? previous.commentUuid : randomUUID();
    return enqueueJob(db, 'post-plan', item.id, { commentUuid }, now);
  }
  return enqueueJob(db, 'investigate', item.id, (previous ?? {}) as JobPayloads['investigate'], now);
}
