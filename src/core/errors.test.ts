import { describe, expect, it } from 'vitest';
import { ActionError, userErrorMessage } from './errors';

describe('userErrorMessage', () => {
  it('shows action errors as-is', () => {
    expect(userErrorMessage(new ActionError('Item #1 is dismissed'))).toBe('Item #1 is dismissed');
  });

  it('turns a busy database into a retryable message', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(userErrorMessage(busy)).toBe('Database busy, try again');
    const snapshot = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
    expect(userErrorMessage(snapshot)).toBe('Database busy, try again');
  });

  it('returns null for anything else, so it is rethrown', () => {
    expect(userErrorMessage(new Error('boom'))).toBeNull();
  });
});
