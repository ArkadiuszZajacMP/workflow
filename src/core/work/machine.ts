import type { WorkState } from '../db/schema';

export type WorkEvent =
  | { type: 'start' }
  | { type: 'plan_saved' }
  | { type: 'user_edited' }
  | { type: 'revise_requested' }
  | { type: 'approved' }
  | { type: 'plan_posted' }
  | { type: 'all_prs_open' }
  | { type: 'job_failed' }
  | { type: 'retry'; to: WorkState };

export type WorkTransitionResult = { ok: true; state: WorkState } | { ok: false; error: string };

type SimpleEvent = Exclude<WorkEvent['type'], 'start' | 'retry'>;

const TABLE: Record<SimpleEvent, { from: readonly WorkState[]; to: WorkState; verb: string }> = {
  plan_saved: { from: ['investigating'], to: 'plan_ready', verb: 'save a plan' },
  user_edited: { from: ['plan_ready'], to: 'plan_ready', verb: 'edit the plan' },
  revise_requested: { from: ['plan_ready'], to: 'investigating', verb: 'revise the plan' },
  approved: { from: ['plan_ready'], to: 'posting_plan', verb: 'approve the plan' },
  plan_posted: { from: ['posting_plan'], to: 'implementing', verb: 'post the plan' },
  all_prs_open: { from: ['implementing'], to: 'prs_open', verb: 'finish implementation' },
  job_failed: { from: ['investigating', 'posting_plan', 'implementing'], to: 'failed', verb: 'fail' },
};

const RETRY_TARGETS: readonly WorkState[] = ['investigating', 'posting_plan', 'implementing'];

export function transitionWork(state: WorkState | null, event: WorkEvent): WorkTransitionResult {
  if (event.type === 'start') {
    return state === null ? { ok: true, state: 'investigating' } : { ok: false, error: `Work already started (${state})` };
  }
  if (event.type === 'retry') {
    if (state !== 'failed') return { ok: false, error: `Cannot retry while work is ${state ?? 'not started'}` };
    if (!RETRY_TARGETS.includes(event.to)) return { ok: false, error: `Cannot retry into ${event.to}` };
    return { ok: true, state: event.to };
  }
  const rule = TABLE[event.type];
  if (state === null || !rule.from.includes(state)) {
    return { ok: false, error: `Cannot ${rule.verb} while work is ${state ?? 'not started'}` };
  }
  return { ok: true, state: rule.to };
}
