import { ErrorCode, WebClient } from '@slack/web-api';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { ThreadMessage } from '../types';
import type { SlackClient, SlackReactionItem } from './types';

export type RawReactionItem = {
  type?: string;
  channel?: string;
  message?: { ts?: string; thread_ts?: string; reactions?: { name?: string; users?: string[] }[] };
};

export function toReactionItems(raw: RawReactionItem[], me: string): SlackReactionItem[] {
  const result: SlackReactionItem[] = [];
  for (const item of raw) {
    if (item.type !== 'message' || !item.channel || !item.message?.ts) continue;
    const mine = (item.message.reactions ?? [])
      .filter((r) => r.name && r.users?.includes(me))
      .map((r) => r.name as string);
    if (mine.length === 0) continue;
    result.push({
      channel: item.channel,
      ts: item.message.ts,
      threadTs: item.message.thread_ts ?? item.message.ts,
      reactions: mine,
    });
  }
  return result;
}

export function mapSlackError(err: unknown): Error {
  const e = err as { code?: string; retryAfter?: number; data?: { error?: string } };
  if (e?.code === ErrorCode.RateLimitedError) return new TransientError('Slack rate limited', (e.retryAfter ?? 30) * 1000);
  if (e?.code === ErrorCode.PlatformError) return new PermanentError(`Slack API error: ${e.data?.error ?? 'unknown'}`);
  return new TransientError(`Slack request failed: ${errorMessage(err)}`);
}

export const SLACK_TIMEOUT_MS = 30_000;

export function createSlackClient(token: string): SlackClient {
  const web = new WebClient(token, { timeout: SLACK_TIMEOUT_MS, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  const names = new Map<string, string>();
  let me: string | undefined;

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapSlackError(err);
    }
  }

  async function myUserId(): Promise<string> {
    me ??= (await call(() => web.auth.test())).user_id as string;
    return me;
  }

  async function userName(userId: string | undefined): Promise<string> {
    if (!userId) return 'unknown';
    const cached = names.get(userId);
    if (cached) return cached;
    try {
      const res = await web.users.info({ user: userId });
      const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
      names.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  return {
    async authTest() {
      const res = await call(() => web.auth.test());
      return { userId: res.user_id as string, team: res.team as string };
    },

    async listMyReactions(cursor) {
      const user = await myUserId();
      const res = await call(() => web.reactions.list({ user, full: true, limit: 100, cursor }));
      return {
        items: toReactionItems((res.items ?? []) as RawReactionItem[], user),
        nextCursor: res.response_metadata?.next_cursor || undefined,
      };
    },

    async getThread(channel, threadTs) {
      const res = await call(() => web.conversations.replies({ channel, ts: threadTs, limit: 200 }));
      const messages: ThreadMessage[] = [];
      for (const m of res.messages ?? []) {
        messages.push({
          ts: m.ts ?? '',
          userName: await userName(m.user ?? m.bot_id),
          text: m.text ?? '',
          files: (m.files ?? []).map((f) => f.name ?? 'file'),
        });
      }
      return messages;
    },

    async getPermalink(channel, ts) {
      const res = await call(() => web.chat.getPermalink({ channel, message_ts: ts }));
      if (!res.permalink) throw new PermanentError('Slack API error: no permalink returned');
      return res.permalink;
    },
  };
}
