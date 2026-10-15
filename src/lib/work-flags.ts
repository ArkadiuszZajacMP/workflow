import type { Item, Workspace } from '@/core/db/schema';

export type WorkFlags = {
  canStart: boolean;
  canEditPlan: boolean;
  canApprove: boolean;
  canRetry: boolean;
  canFix: boolean;
  canStop: boolean;
  canRemoveWorkspace: boolean;
  busy: boolean;
};

export function workFlags(input: {
  item: Pick<Item, 'category' | 'workState' | 'linearIssueId'>;
  activeJob: boolean;
  activeRun: boolean;
  workspace: Pick<Workspace, 'status'> | null;
  hasPlan: boolean;
}): WorkFlags {
  const { item, activeJob, activeRun, workspace, hasPlan } = input;
  const live = item.category !== 'dismissed';
  const idle = live && !activeJob;
  const canEditPlan = idle && item.workState === 'plan_ready';
  return {
    canStart: idle && Boolean(item.linearIssueId) && item.workState === null,
    canEditPlan,
    canApprove: canEditPlan && hasPlan,
    canRetry: idle && item.workState === 'failed',
    canFix: idle && (item.workState === 'implementing' || item.workState === 'prs_open'),
    canStop: live && activeRun,
    canRemoveWorkspace: idle && workspace !== null && workspace.status !== 'removed',
    busy: activeJob,
  };
}
