import type { Category, CiState, Item, TriageState, WorkState } from '@/core/db/schema';

export function formatAge(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  triage: 'Triage',
  in_progress: 'In Progress',
  verification: 'Verification',
  done: 'Done',
  dismissed: 'Dismissed',
};

export const TRIAGE_STATE_LABELS: Record<TriageState, string> = {
  new: 'queued',
  checking_duplicates: 'checking duplicates',
  duplicate_suspected: 'duplicate?',
  drafting: 'drafting',
  draft_ready: 'draft ready',
  creating_issue: 'creating issue',
  linked: 'in Linear',
  failed: 'failed',
};

export function displayTitle(item: Pick<Item, 'title' | 'linearIdentifier' | 'slackChannel'>): string {
  if (item.title) return item.title;
  if (item.linearIdentifier) return item.linearIdentifier;
  if (item.slackChannel) return `Slack thread in ${item.slackChannel}`;
  return 'Untitled';
}

export const WORK_STATE_LABELS: Record<WorkState, string> = {
  investigating: 'investigating',
  plan_ready: 'plan ready',
  posting_plan: 'posting plan',
  implementing: 'implementing',
  prs_open: 'PRs open',
  failed: 'work failed',
};

export const CI_LABELS: Record<CiState, { symbol: string; label: string }> = {
  none: { symbol: '·', label: 'no checks' },
  pending: { symbol: '…', label: 'CI running' },
  success: { symbol: '✓', label: 'CI passing' },
  failure: { symbol: '✗', label: 'CI failing' },
};
