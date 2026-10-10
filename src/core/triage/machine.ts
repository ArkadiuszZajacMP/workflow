import type { TriageState } from '../db/schema';

export type TriageEvent =
  | { type: 'job_started' }
  | { type: 'duplicates_found' }
  | { type: 'no_duplicates' }
  | { type: 'not_duplicate' }
  | { type: 'draft_saved' }
  | { type: 'user_edited' }
  | { type: 'revise_requested' }
  | { type: 'approved' }
  | { type: 'issue_linked' }
  | { type: 'job_failed' }
  | { type: 'retry'; to: TriageState };

export type TransitionResult = { ok: true; state: TriageState } | { ok: false; error: string };

type SimpleEvent = Exclude<TriageEvent['type'], 'retry'>;

const TABLE: Record<SimpleEvent, { from: readonly TriageState[]; to: TriageState }> = {
  job_started: { from: ['new'], to: 'checking_duplicates' },
  duplicates_found: { from: ['checking_duplicates'], to: 'duplicate_suspected' },
  no_duplicates: { from: ['checking_duplicates'], to: 'drafting' },
  not_duplicate: { from: ['duplicate_suspected'], to: 'drafting' },
  draft_saved: { from: ['drafting'], to: 'draft_ready' },
  user_edited: { from: ['draft_ready'], to: 'draft_ready' },
  revise_requested: { from: ['draft_ready'], to: 'drafting' },
  approved: { from: ['draft_ready'], to: 'creating_issue' },
  issue_linked: { from: ['duplicate_suspected', 'draft_ready', 'creating_issue'], to: 'linked' },
  job_failed: {
    from: ['new', 'checking_duplicates', 'duplicate_suspected', 'drafting', 'draft_ready', 'creating_issue'],
    to: 'failed',
  },
};

export function transition(state: TriageState | null, event: TriageEvent): TransitionResult {
  if (state === null) return { ok: false, error: 'Item is not in the triage flow' };

  if (event.type === 'retry') {
    if (state !== 'failed') return { ok: false, error: `Cannot retry while the item is ${state}` };
    if (event.to === 'failed' || event.to === 'linked') return { ok: false, error: `Cannot retry into ${event.to}` };
    return { ok: true, state: event.to };
  }

  const rule = TABLE[event.type];
  if (!rule.from.includes(state)) {
    return { ok: false, error: `Cannot ${event.type.replaceAll('_', ' ')} while the item is ${state}` };
  }
  return { ok: true, state: rule.to };
}
