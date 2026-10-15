import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { eq } from 'drizzle-orm';
import { items, jobs } from '@/core/db/schema';
import { ActionError, PermanentError } from '@/core/errors';
import { getItem } from '@/core/items';
import { claimNextJob, enqueueJob, failJob, isStopRequested, recordJobFailure } from '@/core/jobs/queue';
import { createPlannedPrs, getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { latestPlan, savePlan } from '@/core/work/plans';
import { createWorkspaceRow, updateWorkspace } from '@/core/work/workspaces';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { discard } from './discard';
import { move } from './move';
import { approvePlan, editPlan, fixPr, removeWorkspace, retryWork, revisePlan, startInvestigation, stopRun } from './work';

const plan = { body: 'Scope the parser.', breakdown: [{ repo: 'core', scope: 'Scope raw parser' }] };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});
const queued = () => db.select().from(jobs).all().filter((j) => j.status === 'queued');
const linearItem = (overrides = {}) =>
  seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', category: 'triage', ...overrides });

describe('startInvestigation', () => {
  it('starts investigating and enqueues one job, even when clicked twice', () => {
    const item = linearItem();
    expect(startInvestigation(db, item.id, 5).workState).toBe('investigating');
    expect(() => startInvestigation(db, item.id, 6)).toThrow(ActionError);
    expect(queued()).toMatchObject([{ type: 'investigate', payload: {} }]);
  });

  it('needs a Linear issue and refuses dismissed items', () => {
    expect(() => startInvestigation(db, seedItem(db).id)).toThrow(/no Linear issue/);
    expect(() => startInvestigation(db, linearItem({ category: 'dismissed', linearIssueId: 'i2' }).id)).toThrow(/dismissed/);
  });
});

describe('plan review', () => {
  function planReady() {
    const item = linearItem({ workState: 'plan_ready' });
    savePlan(db, item.id, plan, 'claude', null, 1);
    return item;
  }

  it('saves a cleaned user version and validates repos', () => {
    const item = planReady();
    editPlan(db, item.id, { body: ' Edited ', breakdown: [{ repo: 'web', scope: ' Banner ' }, { repo: '', scope: '' }] }, TEST_REPO_MAP, 5);
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, author: 'user', body: 'Edited', breakdown: [{ repo: 'web', scope: 'Banner' }] });
    expect(() => editPlan(db, item.id, { body: 'x', breakdown: [{ repo: 'mobile', scope: 'x' }] }, TEST_REPO_MAP)).toThrow(/unknown repository "mobile"/);
    expect(() => editPlan(db, item.id, { body: ' ', breakdown: plan.breakdown }, TEST_REPO_MAP)).toThrow(/body/);
  });

  it('revises with feedback', () => {
    const item = planReady();
    expect(() => revisePlan(db, item.id, '  ')).toThrow(/feedback/);
    expect(revisePlan(db, item.id, ' smaller PRs ', 5).workState).toBe('investigating');
    expect(queued()).toMatchObject([{ type: 'investigate', payload: { feedback: 'smaller PRs' } }]);
  });

  it('approves a valid plan once with a comment UUID', () => {
    const item = planReady();
    expect(approvePlan(db, item.id, TEST_REPO_MAP, 5).workState).toBe('posting_plan');
    expect(() => approvePlan(db, item.id, TEST_REPO_MAP, 6)).toThrow(ActionError);
    const [job] = queued();
    expect(job).toMatchObject({ type: 'post-plan' });
    expect((job!.payload as { commentUuid: string }).commentUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to approve a plan whose repos are no longer in the map', () => {
    const item = linearItem({ workState: 'plan_ready' });
    savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'gone', scope: 'x' }] }, 'claude', null, 1);
    expect(() => approvePlan(db, item.id, TEST_REPO_MAP)).toThrow(/unknown repository "gone"/);
  });
});

describe('retryWork', () => {
  it('requeues a failed implement-pr and resets its planned PR', () => {
    const item = linearItem({ workState: 'implementing' });
    const p = savePlan(db, item.id, plan, 'user', null, 1);
    const [pr] = createPlannedPrs(db, item, p, TEST_REPO_MAP, 1);
    enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr!.id }, 1);
    const claimed = claimNextJob(db, 1)!;
    failJob(db, claimed, new PermanentError('push rejected'), 2);
    recordJobFailure(db, claimed, { triage: null, work: 'implementing' }, 'push rejected', 2);

    expect(retryWork(db, item.id, 3)).toMatchObject({ workState: 'implementing', workFailedFromState: null, lastError: null });
    expect(getPlannedPr(db, pr!.id)).toMatchObject({ state: 'pending', lastError: null });
    expect(queued()).toMatchObject([{ id: claimed.id, type: 'implement-pr', attempts: 0 }]);
  });

  it('derives the retry state from the job type when workFailedFromState is null', () => {
    const item = linearItem({ workState: 'implementing' });
    const p = savePlan(db, item.id, plan, 'user', null, 1);
    const [pr] = createPlannedPrs(db, item, p, TEST_REPO_MAP, 1);
    enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr!.id }, 1);
    const claimed = claimNextJob(db, 1)!;
    failJob(db, claimed, new PermanentError('boom'), 2);
    recordJobFailure(db, claimed, { triage: null, work: 'implementing' }, 'boom', 2);
    db.update(items).set({ workFailedFromState: null }).where(eq(items.id, item.id)).run();
    expect(retryWork(db, item.id, 3).workState).toBe('implementing');
  });

  it('refuses when work has not failed', () => {
    expect(() => retryWork(db, linearItem({ workState: 'plan_ready' }).id)).toThrow(/has not failed/);
  });
});

describe('fixPr, stopRun and removeWorkspace', () => {
  function withOpenPr() {
    const item = linearItem({ workState: 'prs_open' });
    const p = savePlan(db, item.id, plan, 'user', null, 1);
    const [pr] = createPlannedPrs(db, item, p, TEST_REPO_MAP, 1);
    updatePlannedPr(db, pr!.id, { state: 'open', prNumber: 12 }, 2);
    return { item, pr: pr! };
  }

  it('enqueues one fix round for an open PR of this item', () => {
    const { item, pr } = withOpenPr();
    fixPr(db, item.id, pr.id, 5);
    expect(() => fixPr(db, item.id, pr.id, 6)).toThrow(/already has a job/);
    expect(queued()).toMatchObject([{ type: 'fix-pr', payload: { plannedPrId: pr.id } }]);
    const other = linearItem({ linearIssueId: 'i9', linearIdentifier: 'BOO-9', workState: 'prs_open' });
    expect(() => fixPr(db, other.id, pr.id)).toThrow(/not part of item/);
  });

  it('refuses a fix round on a merged PR', () => {
    const { item, pr } = withOpenPr();
    updatePlannedPr(db, pr.id, { merged: true }, 3);
    expect(() => fixPr(db, item.id, pr.id)).toThrow(/already merged/);
  });

  it('stops only a running agent job', () => {
    const { item, pr } = withOpenPr();
    expect(() => stopRun(db, item.id)).toThrow(/No agent run/);
    const job = enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr.id }, 1);
    claimNextJob(db, 1);
    stopRun(db, item.id, 2);
    expect(isStopRequested(db, job.id)).toBe(true);
  });

  it('stops a running agent job of a dismissed item, but still needs one', () => {
    const { item, pr } = withOpenPr();
    db.update(items).set({ category: 'dismissed' }).where(eq(items.id, item.id)).run();
    expect(() => stopRun(db, item.id)).toThrow(/No agent run/);
    const job = enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr.id }, 1);
    claimNextJob(db, 1);
    stopRun(db, item.id, 2);
    expect(isStopRequested(db, job.id)).toBe(true);
  });

  it('requests a stop of the running agent job when the item is dismissed', () => {
    const dismissals = [(id: number) => discard(db, id, 3), (id: number) => move(db, id, 'dismissed', 3)];
    dismissals.forEach((dismiss, i) => {
      const item = linearItem({ linearIssueId: `d${i}`, linearIdentifier: `BOO-${20 + i}`, workState: 'investigating' });
      const job = enqueueJob(db, 'investigate', item.id, {}, 1);
      claimNextJob(db, 1);
      dismiss(item.id);
      expect(isStopRequested(db, job.id)).toBe(true);
    });
    const quiet = linearItem({ linearIssueId: 'i5', linearIdentifier: 'BOO-5' });
    expect(() => discard(db, quiet.id, 4)).not.toThrow();
  });

  it('enqueues workspace removal when a workspace exists', () => {
    const item = linearItem();
    expect(() => removeWorkspace(db, item.id)).toThrow(/no workspace/);
    createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 1);
    removeWorkspace(db, item.id, 2);
    expect(queued()).toMatchObject([{ type: 'remove-workspace' }]);
    updateWorkspace(db, item.id, { status: 'removed' }, 3);
    db.delete(jobs).run();
    expect(() => removeWorkspace(db, item.id)).toThrow(/no workspace/);
    expect(getItem(db, item.id)?.id).toBe(item.id);
  });
});
