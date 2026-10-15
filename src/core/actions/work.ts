import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { Item, JobType, Plan } from '../db/schema';
import { writeTransaction } from '../db/tx';
import { ActionError } from '../errors';
import { logActivity, updateItem } from '../items';
import { enqueueJob, latestFailedJob, requestStop, requeueJob, runningAgentJob } from '../jobs/queue';
import { type RepoMap, validateBreakdown } from '../repos/map';
import { getPlannedPr, updatePlannedPr } from '../work/planned-prs';
import { cleanPlanContent, latestPlan, type PlanContent, savePlan } from '../work/plans';
import { applyWorkEvent } from '../work/state';
import { getWorkspace } from '../work/workspaces';
import { assertNoActiveJob, requireActiveItem } from './guards';

const WORK_JOB_TYPES: readonly JobType[] = ['investigate', 'post-plan', 'implement-pr'];

export function startInvestigation(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (!item.linearIssueId) throw new ActionError(`Item #${itemId} has no Linear issue yet`);
    assertNoActiveJob(tx, itemId);
    const updated = applyWorkEvent(tx, itemId, { type: 'start' }, now);
    enqueueJob(tx, 'investigate', itemId, {}, now);
    logActivity(tx, itemId, 'Investigation started', now);
    return updated;
  });
}

function assertValidPlan(content: PlanContent, map: RepoMap): void {
  if (!content.body) throw new ActionError('The plan body cannot be empty');
  const error = validateBreakdown(content.breakdown, map);
  if (error) throw new ActionError(error);
}

export function editPlan(db: Db, itemId: number, content: PlanContent, map: RepoMap, now = Date.now()): Plan {
  const clean = cleanPlanContent(content);
  assertValidPlan(clean, map);
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    applyWorkEvent(tx, itemId, { type: 'user_edited' }, now);
    const plan = savePlan(tx, itemId, clean, 'user', null, now);
    logActivity(tx, itemId, `Plan v${plan.version} edited`, now);
    return plan;
  });
}

export function revisePlan(db: Db, itemId: number, feedback: string, now = Date.now()): Item {
  const trimmed = feedback.trim();
  if (!trimmed) throw new ActionError('Revision feedback cannot be empty');
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    assertNoActiveJob(tx, itemId);
    const item = applyWorkEvent(tx, itemId, { type: 'revise_requested' }, now);
    enqueueJob(tx, 'investigate', itemId, { feedback: trimmed }, now);
    logActivity(tx, itemId, `Plan revision requested: ${trimmed}`, now);
    return item;
  });
}

export function approvePlan(db: Db, itemId: number, map: RepoMap, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    const plan = latestPlan(tx, itemId);
    if (!plan) throw new ActionError(`Item #${itemId} has no plan to approve`);
    assertValidPlan(plan, map);
    assertNoActiveJob(tx, itemId);
    const item = applyWorkEvent(tx, itemId, { type: 'approved' }, now);
    enqueueJob(tx, 'post-plan', itemId, { commentUuid: randomUUID() }, now);
    logActivity(tx, itemId, `Plan v${plan.version} approved, posting to Linear`, now);
    return item;
  });
}

export function retryWork(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (item.workState !== 'failed') throw new ActionError(`Item #${itemId} work has not failed`);
    const job = latestFailedJob(tx, itemId, WORK_JOB_TYPES);
    if (!job) throw new ActionError(`Item #${itemId} has no failed work job to retry`);
    if (job.type === 'implement-pr') {
      const { plannedPrId } = job.payload as { plannedPrId: number };
      updatePlannedPr(tx, plannedPrId, { state: 'pending', lastError: null }, now);
    }
    applyWorkEvent(tx, itemId, { type: 'retry', to: item.workFailedFromState ?? 'investigating' }, now);
    requeueJob(tx, job.id, now);
    logActivity(tx, itemId, `Retrying ${job.type}`, now);
    return updateItem(tx, itemId, { workFailedFromState: null, lastError: null }, now);
  });
}

export function fixPr(db: Db, itemId: number, plannedPrId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (item.workState !== 'implementing' && item.workState !== 'prs_open') {
      throw new ActionError(`Item #${itemId} has no open PRs to fix`);
    }
    const pr = getPlannedPr(tx, plannedPrId);
    if (!pr || pr.itemId !== itemId) throw new ActionError(`PR #${plannedPrId} is not part of item #${itemId}`);
    if (pr.state !== 'open' || !pr.prNumber) throw new ActionError(`PR ${pr.position} is not open yet`);
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'fix-pr', itemId, { plannedPrId }, now);
    logActivity(tx, itemId, `Fix round requested for ${pr.githubRepo}#${pr.prNumber}`, now);
    return item;
  });
}

export function stopRun(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    const job = runningAgentJob(tx, itemId);
    if (!job) throw new ActionError(`No agent run is active for item #${itemId}`);
    requestStop(tx, job.id);
    logActivity(tx, itemId, `Stop requested for ${job.type}`, now);
    return item;
  });
}

export function removeWorkspace(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    const ws = getWorkspace(tx, itemId);
    if (!ws || ws.status === 'removed') throw new ActionError(`Item #${itemId} has no workspace`);
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'remove-workspace', itemId, {}, now);
    logActivity(tx, itemId, 'Workspace removal requested', now);
    return item;
  });
}
