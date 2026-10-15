import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { errorMessage, PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob, jobPayload } from '@/core/jobs/queue';
import { validateBreakdown } from '@/core/repos/map';
import { createPlannedPrs, listPlannedPrs } from '@/core/work/planned-prs';
import { latestPlan, renderPlanComment } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { Handler } from './types';

export const postPlanHandler: Handler = async (ctx, job: Job) => {
  const { db, linear } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'posting_plan') return;
  if (!item.linearIssueId || !item.linearIdentifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const plan = latestPlan(db, item.id);
  if (!plan) throw new PermanentError(`Item #${item.id} has no plan`);
  if (!ctx.repoMap) throw new PermanentError('Repository map is not available to the worker');
  const map = ctx.repoMap();
  const invalid = validateBreakdown(plan.breakdown, map);
  if (invalid) throw new PermanentError(invalid);

  const { commentUuid } = jobPayload(job as Job & { type: 'post-plan' });
  if (!(await linear.commentExists(commentUuid))) {
    await linear.createComment({ id: commentUuid, issueId: item.linearIssueId, body: renderPlanComment(plan) });
  }
  if (getItem(db, item.id)?.category === 'dismissed') {
    updateItem(db, item.id, { planCommentId: commentUuid }, ctx.now());
    return;
  }

  const now = ctx.now();
  writeTransaction(db, (tx) => {
    updateItem(tx, item.id, { planCommentId: commentUuid, category: 'in_progress' }, now);
    const prs = listPlannedPrs(tx, item.id).length > 0 ? listPlannedPrs(tx, item.id) : createPlannedPrs(tx, item, plan, map, now);
    applyWorkEvent(tx, item.id, { type: 'plan_posted' }, now);
    enqueueJob(tx, 'implement-pr', item.id, { plannedPrId: prs[0]!.id }, now);
    logActivity(tx, item.id, `Plan v${plan.version} posted to ${item.linearIdentifier}; implementing ${prs.length} PR${prs.length === 1 ? '' : 's'}`, now);
  });

  const status = ctx.config.agent.linearStatusOnImplement;
  if (status) {
    try {
      await linear.setIssueStateByName(item.linearIssueId, status);
    } catch (err) {
      updateItem(db, item.id, { lastError: errorMessage(err) }, ctx.now());
      logActivity(db, item.id, `Could not move ${item.linearIdentifier} to "${status}": ${errorMessage(err)}`, ctx.now());
    }
  }
};
