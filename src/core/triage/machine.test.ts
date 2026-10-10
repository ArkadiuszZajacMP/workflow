import { describe, expect, it } from 'vitest';
import type { TriageState } from '@/core/db/schema';
import { type TriageEvent, transition } from './machine';

const ok = (state: TriageState) => ({ ok: true, state });

describe('transition', () => {
  it.each<[TriageState, TriageEvent, TriageState]>([
    ['new', { type: 'job_started' }, 'checking_duplicates'],
    ['checking_duplicates', { type: 'duplicates_found' }, 'duplicate_suspected'],
    ['checking_duplicates', { type: 'no_duplicates' }, 'drafting'],
    ['duplicate_suspected', { type: 'not_duplicate' }, 'drafting'],
    ['drafting', { type: 'draft_saved' }, 'draft_ready'],
    ['draft_ready', { type: 'user_edited' }, 'draft_ready'],
    ['draft_ready', { type: 'revise_requested' }, 'drafting'],
    ['draft_ready', { type: 'approved' }, 'creating_issue'],
    ['creating_issue', { type: 'issue_linked' }, 'linked'],
    ['duplicate_suspected', { type: 'issue_linked' }, 'linked'],
    ['draft_ready', { type: 'issue_linked' }, 'linked'],
    ['drafting', { type: 'job_failed' }, 'failed'],
    ['creating_issue', { type: 'job_failed' }, 'failed'],
    ['failed', { type: 'retry', to: 'creating_issue' }, 'creating_issue'],
  ])('%s + %o → %s', (from, event, to) => {
    expect(transition(from, event)).toEqual(ok(to));
  });

  it('rejects approving while a draft is still being written', () => {
    expect(transition('drafting', { type: 'approved' })).toEqual({
      ok: false,
      error: 'Cannot approved while the item is drafting',
    });
  });

  it('rejects any event for items outside the triage flow', () => {
    expect(transition(null, { type: 'approved' })).toMatchObject({ ok: false });
  });

  it('only retries failed items, and never into failed or linked', () => {
    expect(transition('draft_ready', { type: 'retry', to: 'drafting' }).ok).toBe(false);
    expect(transition('failed', { type: 'retry', to: 'linked' }).ok).toBe(false);
    expect(transition('failed', { type: 'retry', to: 'failed' }).ok).toBe(false);
  });

  it('does not fail an item that is already linked', () => {
    expect(transition('linked', { type: 'job_failed' }).ok).toBe(false);
  });
});
