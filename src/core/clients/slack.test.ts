import { ErrorCode } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { mapSlackError, toReactionItems } from './slack';

describe('toReactionItems', () => {
  it('keeps only messages with reactions by me and resolves the thread root', () => {
    const raw = [
      {
        type: 'message',
        channel: 'C1',
        message: {
          ts: '2.0',
          thread_ts: '1.0',
          reactions: [
            { name: 'eyes', users: ['U_ME', 'U2'] },
            { name: 'tada', users: ['U2'] },
          ],
        },
      },
      { type: 'message', channel: 'C1', message: { ts: '3.0', reactions: [{ name: 'eyes', users: ['U2'] }] } },
      { type: 'file', channel: 'C1' },
      { type: 'message', channel: 'C2', message: { ts: '4.0', reactions: [{ name: 'bookmark', users: ['U_ME'] }] } },
    ];
    expect(toReactionItems(raw, 'U_ME')).toEqual([
      { channel: 'C1', ts: '2.0', threadTs: '1.0', reactions: ['eyes'] },
      { channel: 'C2', ts: '4.0', threadTs: '4.0', reactions: ['bookmark'] },
    ]);
  });
});

describe('mapSlackError', () => {
  it('maps rate limits to TransientError with Retry-After', () => {
    const err = mapSlackError({ code: ErrorCode.RateLimitedError, retryAfter: 12 });
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).retryAfterMs).toBe(12_000);
  });

  it('maps platform errors to PermanentError', () => {
    const err = mapSlackError({ code: ErrorCode.PlatformError, data: { error: 'channel_not_found' } });
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Slack API error: channel_not_found');
  });

  it('treats anything else as transient', () => {
    expect(mapSlackError(new Error('ECONNRESET'))).toBeInstanceOf(TransientError);
  });
});
