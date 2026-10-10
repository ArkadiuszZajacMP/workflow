import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { saveDraft } from '@/core/drafts';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, updateItem, upsertLinearItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { createLinearIssueHandler } from './create-linear-issue';
import { linkLinearIssueHandler } from './link-linear-issue';
import type { HandlerContext } from './types';

const PERMALINK = 'https://slack.test/archives/C1/p10';
let db: Db;
let linear: FakeLinear;
let ctx: HandlerContext;

beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear, claude: new FakeClaude(), now: () => 1_000 };
});

function approvedItem() {
  const item = seedItem(db, { triageState: 'creating_issue', slackChannel: 'C1', slackThreadTs: '1.0', slackPermalink: PERMALINK });
  saveDraft(db, item.id, { title: 'CSV export returns 500', problem: 'Export fails.', acceptanceCriteria: ['Export works'] }, 'claude', null, 1);
  enqueueJob(db, 'create-linear-issue', item.id, {}, 0);
  return { item, job: claimNextJob(db, 0)! };
}

describe('createLinearIssueHandler', () => {
  it('creates the issue in the default team, attaches the thread and links the item', async () => {
    const { item, job } = approvedItem();
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([
      {
        teamId: 'team-ENG',
        title: 'CSV export returns 500',
        description: '## Problem\nExport fails.\n\n## Acceptance criteria\n- [ ] Export works\n',
      },
    ]);
    expect(linear.attached).toEqual([{ issueId: 'issue-100', url: PERMALINK, title: 'Slack thread' }]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIdentifier: 'ENG-100' });
  });

  it('links instead of creating when the thread is already attached to an issue', async () => {
    const { item, job } = approvedItem();
    const existing = { id: 'i9', identifier: 'ENG-9', title: 'Existing', url: 'u9' };
    linear.attachmentsByUrl.set(PERMALINK, existing);
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIdentifier: 'ENG-9' });
  });

  it('does not create a second issue when a retry follows a failed attach', async () => {
    const { item, job } = approvedItem();
    linear.failures.attachUrl = new TransientError('timeout');
    await expect(createLinearIssueHandler(ctx, job)).rejects.toThrow('timeout');
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'creating_issue', linearIdentifier: 'ENG-100' });

    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toHaveLength(1);
    expect(getItem(db, item.id)?.triageState).toBe('linked');
  });

  it('records the created issue but does not link when dismissed during the Linear calls', async () => {
    const { item, job } = approvedItem();
    const attach = linear.attachUrl.bind(linear);
    linear.attachUrl = async (...args) => {
      await attach(...args);
      updateItem(db, item.id, { category: 'dismissed' });
    };
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toHaveLength(1);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'creating_issue', linearIssueId: 'issue-100' });
  });

  it('does nothing for a dismissed item', async () => {
    const { item, job } = approvedItem();
    updateItem(db, item.id, { category: 'dismissed' });
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([]);
  });
});

describe('linkLinearIssueHandler', () => {
  function linkJob(triageState: 'duplicate_suspected' | 'draft_ready', identifier: string) {
    const item = seedItem(db, { triageState, slackChannel: 'C1', slackThreadTs: '1.0', slackPermalink: PERMALINK });
    enqueueJob(db, 'link-linear-issue', item.id, { identifier }, 0);
    return { item, job: claimNextJob(db, 0)! };
  }

  it('resolves the identifier, attaches the thread and links', async () => {
    linear.addIssue({ id: 'i7', identifier: 'ENG-7', title: 'Export 500', url: 'u7' });
    const { item, job } = linkJob('duplicate_suspected', 'ENG-7');
    await linkLinearIssueHandler(ctx, job);
    expect(linear.attached).toEqual([{ issueId: 'i7', url: PERMALINK, title: 'Slack thread' }]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIssueId: 'i7' });
  });

  it('fails permanently for an unknown identifier', async () => {
    const { job } = linkJob('draft_ready', 'ENG-404');
    await expect(linkLinearIssueHandler(ctx, job)).rejects.toBeInstanceOf(PermanentError);
  });

  it('merges the Linear-only item that the poller created for the same issue', async () => {
    const ref = { id: 'i7', identifier: 'ENG-7', title: 'Export 500', url: 'u7' };
    linear.addIssue(ref);
    const linearOnly = upsertLinearItem(db, ref, 'triage', 1);
    const { item, job } = linkJob('duplicate_suspected', 'ENG-7');
    await linkLinearIssueHandler(ctx, job);
    expect(getItem(db, item.id)?.linearIssueId).toBe('i7');
    expect(getItem(db, linearOnly.id)?.category).toBe('dismissed');
  });
});
