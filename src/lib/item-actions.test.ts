import { describe, expect, it } from 'vitest';
import { itemActionFlags } from './item-actions';

describe('itemActionFlags', () => {
  it('enables draft editing and linking only when a draft is ready and idle', () => {
    expect(itemActionFlags({ triageState: 'draft_ready', category: 'triage' }, false)).toEqual({
      busy: false, canResolveDuplicate: false, canEditDraft: true, canLink: true, canRetry: false, canDiscard: true,
    });
    expect(itemActionFlags({ triageState: 'draft_ready', category: 'triage' }, true)).toMatchObject({
      busy: true, canEditDraft: false, canLink: false,
    });
  });

  it('enables duplicate resolution for suspected duplicates', () => {
    expect(itemActionFlags({ triageState: 'duplicate_suspected', category: 'triage' }, false)).toMatchObject({
      canResolveDuplicate: true, canLink: true, canEditDraft: false,
    });
  });

  it('marks job-driven states as busy and allows retry only for failed items', () => {
    expect(itemActionFlags({ triageState: 'drafting', category: 'triage' }, false).busy).toBe(true);
    expect(itemActionFlags({ triageState: 'failed', category: 'triage' }, false).canRetry).toBe(true);
  });

  it('cannot discard what is already dismissed', () => {
    expect(itemActionFlags({ triageState: null, category: 'dismissed' }, false).canDiscard).toBe(false);
  });

  it('offers no triage actions for a dismissed item', () => {
    for (const triageState of ['draft_ready', 'duplicate_suspected', 'failed'] as const) {
      expect(itemActionFlags({ triageState, category: 'dismissed' }, false)).toEqual({
        busy: false, canResolveDuplicate: false, canEditDraft: false, canLink: false, canRetry: false, canDiscard: false,
      });
    }
  });

  it('does not show a dismissed item in a job-driven state as working when no job is active', () => {
    expect(itemActionFlags({ triageState: 'drafting', category: 'dismissed' }, false).busy).toBe(false);
  });
});
