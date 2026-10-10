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
});
