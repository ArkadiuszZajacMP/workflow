import { ErrorCode } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { createSlackClient, mapSlackError, toReactionItems } from './slack';

const webClientOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@slack/web-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slack/web-api')>();
  return {
    ...actual,
    WebClient: class {
      constructor(_token: string, options: unknown) {
        webClientOptions.push(options);
      }
    },
  };
});

describe('createSlackClient', () => {
  it('gives every request a 30 second timeout and no built-in retries', () => {
    createSlackClient('xoxp-test');
    expect(webClientOptions.at(-1)).toMatchObject({ timeout: 30_000, retryConfig: { retries: 0 } });
  });
});

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

  it.each(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited'])(
    'maps the server-side platform error %s to TransientError',
    (code) => {
      const err = mapSlackError({ code: ErrorCode.PlatformError, data: { error: code } });
      expect(err).toBeInstanceOf(TransientError);
      expect(err.message).toBe(`Slack API error: ${code}`);
    },
  );

  it('treats anything else as transient', () => {
    expect(mapSlackError(new Error('ECONNRESET'))).toBeInstanceOf(TransientError);
  });
});
