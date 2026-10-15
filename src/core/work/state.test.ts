import { describe, expect, it } from 'vitest';
import { ActionError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { applyWorkEvent, markWorkFailed } from './state';

describe('work state helpers', () => {
  it('applies valid events and clears lastError', () => {
    const db = createTestDb();
    const item = seedItem(db, { lastError: 'old' });
    expect(applyWorkEvent(db, item.id, { type: 'start' }, 5)).toMatchObject({ workState: 'investigating', lastError: null });
    expect(() => applyWorkEvent(db, item.id, { type: 'start' }, 6)).toThrow(ActionError);
  });

  it('fails work and remembers where to resume', () => {
    const db = createTestDb();
    const item = seedItem(db, { workState: 'implementing' });
    markWorkFailed(db, item.id, 'implementing', 'GitHub authentication failed', 9);
    expect(getItem(db, item.id)).toMatchObject({
      workState: 'failed',
      workFailedFromState: 'implementing',
      lastError: 'GitHub authentication failed',
    });
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Failed: GitHub authentication failed');
  });

  it('only records the error when the work cannot fail', () => {
    const db = createTestDb();
    const item = seedItem(db, { workState: 'prs_open' });
    markWorkFailed(db, item.id, 'prs_open', 'boom', 9);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', lastError: 'boom' });
  });
});
