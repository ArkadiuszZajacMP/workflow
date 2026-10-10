import type { SlackClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import { getCursor, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { type SlackReactionEvent, slackEventKey } from '@/core/events';
import { ingestEvent } from '@/core/ingest';

export const MAX_SLACK_PAGES = 50;

/**
 * Reads the user's reactions newest-first and ingests unseen ones. Slack gives no reaction
 * timestamps, so the first run only records a baseline unless `backfillOnFirstRun` is set.
 */
export async function pollSlack(
  deps: { db: Db; slack: SlackClient; config: Config },
  now = Date.now(),
): Promise<{ newEvents: number }> {
  const { db, slack, config } = deps;
  const firstRun = !getCursor(db, 'slack')?.cursor;
  const rules = firstRun && !config.slack.backfillOnFirstRun ? null : config.rules;
  let newEvents = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SLACK_PAGES; page++) {
    const { items, nextCursor } = await slack.listMyReactions(cursor);
    let pageHadNew = false;
    for (const item of items) {
      for (const reaction of item.reactions) {
        const event: SlackReactionEvent = {
          source: 'slack',
          kind: 'reaction_added',
          reaction,
          channel: item.channel,
          ts: item.ts,
          threadTs: item.threadTs,
        };
        if (ingestEvent(db, event, slackEventKey(item.channel, item.ts, reaction), rules, now).inserted) {
          newEvents++;
          pageHadNew = true;
        }
      }
    }
    if ((!pageHadNew && !firstRun) || !nextCursor) break;
    cursor = nextCursor;
  }

  recordPollSuccess(db, 'slack', 'initialized', now);
  return { newEvents };
}
