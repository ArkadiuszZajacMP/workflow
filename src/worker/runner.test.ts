import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCursor } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { approve, link } from '@/core/actions';
import { saveDraft } from '@/core/drafts';
import { enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import type { Handler, HandlerContext } from './handlers/types';
import { HANDLERS, pollOnce, runNextJob } from './runner';

let db: Db;
let ctx: HandlerContext;
beforeEach(() => {
  db = createTestDb();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear: new FakeLinear(), claude: new FakeClaude(), now: () => 1_000 };
});

const withDraftHandler = (handler: Handler) => ({ ...HANDLERS, draft: handler });

describe('runNextJob', () => {
  it('returns false when nothing is due', async () => {
    await expect(runNextJob(ctx)).resolves.toBe(false);
  });

  it('completes a successful job', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    const job = enqueueJob(db, 'draft', item.id, {}, 0);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(true);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe('done');
  });

  it('reschedules a transient failure and leaves the item state alone', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    enqueueJob(db, 'draft', item.id, {}, 0);
    await runNextJob(ctx, withDraftHandler(async () => { throw new TransientError('Claude busy'); }));
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Retrying draft later: Claude busy');
  });

  it('fails the item on a permanent failure, remembering the state the job started from', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    enqueueJob(db, 'draft', item.id, {}, 0);
    await runNextJob(ctx, withDraftHandler(async () => { throw new PermanentError('Claude returned invalid output for draft'); }));
    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'failed',
      failedFromState: 'drafting',
      lastError: 'Claude returned invalid output for draft',
    });
  });
});

describe('a failed link job', () => {
  it('keeps the item pickable with lastError set, and a later approve clears the error', async () => {
    const item = seedItem(db, { triageState: 'draft_ready', slackChannel: 'C1', slackThreadTs: '1.0', slackPermalink: 'p' });
    saveDraft(db, item.id, { title: 'T', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    link(db, item.id, { identifier: 'ENG-404' }, 0);
    await runNextJob(ctx);

    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'draft_ready',
      failedFromState: null,
      lastError: 'Linear issue ENG-404 not found',
    });
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Link to ENG-404 failed: Linear issue ENG-404 not found');

    expect(approve(db, item.id, 2)).toMatchObject({ triageState: 'creating_issue', lastError: null });
  });

  it('clears lastError when the user picks another issue to link', async () => {
    const item = seedItem(db, { triageState: 'duplicate_suspected', lastError: 'Link to ENG-404 failed: not found' });
    expect(link(db, item.id, { identifier: 'ENG-5' }, 0).lastError).toBeNull();
  });
});

describe('pollOnce', () => {
  it('records a config error, keeps polling with the last valid config', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: 'Invalid config: rules.0' }) };
    await expect(pollOnce({ db, slack, linear: new FakeLinear(), configStore }, 10)).resolves.toBe(TEST_CONFIG);
    expect(getCursor(db, 'config')?.lastError).toBe('Invalid config: rules.0');
    expect(getCursor(db, 'slack')?.lastSuccessAt).toBe(10);
  });

  it('isolates poller failures', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const linear = new FakeLinear();
    linear.failures.listMyIssuesUpdatedSince = new TransientError('Linear server error 502');
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: null }) };
    await pollOnce({ db, slack, linear, configStore }, 10);
    expect(getCursor(db, 'linear')?.lastError).toBe('Linear server error 502');
    expect(getCursor(db, 'slack')?.lastError).toBeNull();
  });

  it('skips polling when there has never been a valid config', async () => {
    const slack = new FakeSlack();
    const configStore = { reload: () => ({ config: null, error: 'Cannot read workflow.config.yaml' }) };
    await expect(pollOnce({ db, slack, linear: new FakeLinear(), configStore }, 10)).resolves.toBeNull();
    expect(slack.listCalls).toEqual([]);
  });
});

describe('core lane', () => {
  it('never claims agent jobs', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    const agentJob = enqueueJob(db, 'investigate', item.id, {}, 0);
    enqueueJob(db, 'draft', item.id, {}, 0);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(true);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, agentJob.id)).get()?.status).toBe('queued');
  });
});
