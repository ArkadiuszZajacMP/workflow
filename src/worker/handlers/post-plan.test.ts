import { beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { listPlannedPrs } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { postPlanHandler } from './post-plan';
import type { HandlerContext } from './types';

const UUID = '6f1c1d2e-1111-4a5b-8c9d-0123456789ab';
let db: Db;
let linear: FakeLinear;
let ctx: HandlerContext;

beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear, claude: new FakeClaude(), now: () => 1_000, repoMap: () => TEST_REPO_MAP };
});

function approved(breakdown = [{ repo: 'core', scope: 'Add field' }, { repo: 'web', scope: 'Show field' }]) {
  const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-7', workState: 'posting_plan', category: 'triage' });
  savePlan(db, item.id, { body: 'Findings and approach', breakdown }, 'claude', null, 0);
  enqueueJob(db, 'post-plan', item.id, { commentUuid: UUID }, 0);
  return { item, job: claimNextJob(db, 0)! };
}

describe('postPlanHandler', () => {
  it('posts the plan comment and starts implementation of PR 1', async () => {
    const { item, job } = approved();
    await postPlanHandler(ctx, job);
    expect(linear.comments).toEqual([
      {
        id: UUID,
        issueId: 'i1',
        body: '## Implementation plan\n\nFindings and approach\n\n### PR breakdown\n1. `core` — Add field\n2. `web` — Show field\n',
      },
    ]);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'implementing', category: 'in_progress', planCommentId: UUID });
    const prs = listPlannedPrs(db, item.id);
    expect(prs.map((p) => p.branch)).toEqual(['boo-7-add-field', 'boo-7-show-field']);
    const queued = db.select().from(jobs).all().filter((j) => j.status === 'queued');
    expect(queued).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[0]!.id } }]);
  });

  it('never posts twice after a lost response', async () => {
    const { item, job } = approved();
    linear.loseNextCommentResponse = true;
    await expect(postPlanHandler(ctx, job)).rejects.toBeInstanceOf(TransientError);
    await postPlanHandler(ctx, job);
    expect(linear.comments).toHaveLength(1);
    expect(getItem(db, item.id)?.workState).toBe('implementing');
  });

  it('optionally moves the Linear issue, without blocking on failure', async () => {
    const { item, job } = approved();
    ctx.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { linearStatusOnImplement: 'In Progress' } });
    await postPlanHandler(ctx, job);
    expect(linear.stateChanges).toEqual([{ issueId: 'i1', stateName: 'In Progress' }]);

    const second = (() => {
      const it2 = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-8', workState: 'posting_plan' });
      savePlan(db, it2.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'claude', null, 0);
      enqueueJob(db, 'post-plan', it2.id, { commentUuid: '7f1c1d2e-1111-4a5b-8c9d-0123456789ab' }, 0);
      return { it2, job2: claimNextJob(db, 0, ['post-plan'])! };
    })();
    ctx.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { linearStatusOnImplement: 'Shipped' } });
    await postPlanHandler(ctx, second.job2);
    expect(getItem(db, second.it2.id)).toMatchObject({ workState: 'implementing', lastError: 'Linear state "Shipped" not found' });
    expect(listActivity(db, second.it2.id).at(-1)?.message).toContain('Could not move BOO-8');
    expect(item.id).not.toBe(second.it2.id);
  });

  it('fails permanently when the breakdown no longer matches the map', async () => {
    const { job } = approved([{ repo: 'gone', scope: 'x' }]);
    await expect(postPlanHandler(ctx, job)).rejects.toBeInstanceOf(PermanentError);
    expect(linear.comments).toHaveLength(0);
  });
});
