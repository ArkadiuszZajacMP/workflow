import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { items, jobs, sourceEvents } from '@/core/db/schema';
import { getCursor } from '@/core/cursors';
import { createTestDb } from '@/test/db';
import { FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { pollSlack } from './slack';

let db: Db;
let slack: FakeSlack;
beforeEach(() => {
  db = createTestDb();
  slack = new FakeSlack();
});

const eyesOn = (ts: string, threadTs = ts) => ({ channel: 'C1', ts, threadTs, reactions: ['eyes'] });

describe('pollSlack', () => {
  it('records existing reactions on the first run without creating items', async () => {
    slack.setPages([eyesOn('1.0')]);
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 10)).resolves.toEqual({ newEvents: 1 });
    expect(db.select().from(items).all()).toHaveLength(0);
    expect(getCursor(db, 'slack')).toMatchObject({ cursor: 'initialized', lastSuccessAt: 10 });
  });

  it('creates items on the first run when backfill is enabled', async () => {
    slack.setPages([eyesOn('1.0')]);
    const config = { ...TEST_CONFIG, slack: { ...TEST_CONFIG.slack, backfillOnFirstRun: true } };
    await pollSlack({ db, slack, config }, 10);
    expect(db.select().from(items).all()).toHaveLength(1);
  });

  it('creates an item and triage job for a new 👀, and nothing on a repeat poll', async () => {
    slack.setPages([]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);

    slack.setPages([eyesOn('2.0')]);
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 1 });
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 30)).resolves.toEqual({ newEvents: 0 });
    expect(db.select().from(items).all()).toMatchObject([{ slackChannel: 'C1', slackThreadTs: '2.0', triageState: 'new' }]);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('stops paging at the first page with nothing new', async () => {
    slack.setPages([eyesOn('1.0')], [eyesOn('0.5')]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);
    expect(slack.listCalls).toEqual([undefined, '1']);

    slack.listCalls = [];
    slack.setPages([eyesOn('3.0'), eyesOn('1.0')], [eyesOn('0.5')]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 20);
    expect(slack.listCalls).toEqual([undefined, '1']);

    slack.listCalls = [];
    await pollSlack({ db, slack, config: TEST_CONFIG }, 30);
    expect(slack.listCalls).toEqual([undefined]);
  });

  it('stores unmatched reactions without creating items', async () => {
    slack.setPages([]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);
    slack.setPages([{ channel: 'C1', ts: '5.0', threadTs: '5.0', reactions: ['tada'] }]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 20);
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
});
