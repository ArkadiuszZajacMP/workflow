import { describe, expect, it } from 'vitest';
import { workFlags } from './work-flags';

const base = {
  item: { category: 'triage' as const, workState: null, linearIssueId: 'i1' },
  activeJob: false,
  activeRun: false,
  workspace: null,
  hasPlan: false,
};

describe('workFlags', () => {
  it('allows starting only with a Linear issue, no work and no job', () => {
    expect(workFlags(base).canStart).toBe(true);
    expect(workFlags({ ...base, item: { ...base.item, linearIssueId: null } }).canStart).toBe(false);
    expect(workFlags({ ...base, activeJob: true }).canStart).toBe(false);
    expect(workFlags({ ...base, item: { ...base.item, category: 'dismissed' } }).canStart).toBe(false);
  });

  it('enables plan editing and approval when the plan is ready', () => {
    const flags = workFlags({ ...base, item: { ...base.item, workState: 'plan_ready' }, hasPlan: true });
    expect(flags).toMatchObject({ canStart: false, canEditPlan: true, canApprove: true });
  });

  it('enables fixing open PRs, stopping a run and removing an idle workspace', () => {
    const flags = workFlags({ ...base, item: { ...base.item, workState: 'prs_open' }, workspace: { status: 'ready' } });
    expect(flags).toMatchObject({ canFix: true, canRemoveWorkspace: true, canStop: false });
    expect(workFlags({ ...base, item: { ...base.item, workState: 'implementing' }, activeJob: true, activeRun: true, workspace: { status: 'ready' } })).toMatchObject({
      canFix: false,
      canStop: true,
      canRemoveWorkspace: false,
      busy: true,
    });
    expect(workFlags({ ...base, item: { ...base.item, workState: 'failed' } }).canRetry).toBe(true);
  });

  it('keeps a running agent stoppable after the item is dismissed', () => {
    const dismissed = { ...base.item, category: 'dismissed' as const, workState: 'implementing' as const };
    expect(workFlags({ ...base, item: dismissed, activeJob: true, activeRun: true }).canStop).toBe(true);
    expect(workFlags({ ...base, item: dismissed, activeJob: true, activeRun: false }).canStop).toBe(false);
  });
});
