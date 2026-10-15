import { describe, expect, it } from 'vitest';
import { getCursor } from '@/core/cursors';
import { createPlannedPrs, getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createTestDb } from '@/test/db';
import { FakeGitHub } from '@/test/fakes';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { pollGithub } from './github';

describe('pollGithub', () => {
  it('refreshes open PRs of active items only', async () => {
    const db = createTestDb();
    const github = new FakeGitHub();
    const active = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const done = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-2', workState: null });
    const planA = savePlan(db, active.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }, { repo: 'web', scope: 'y' }] }, 'user', null, 0);
    const [a1, a2] = createPlannedPrs(db, active, planA, TEST_REPO_MAP, 0);
    updatePlannedPr(db, a1!.id, { state: 'open', prNumber: 12 }, 0);
    const planB = savePlan(db, done.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'z' }] }, 'user', null, 0);
    const [b1] = createPlannedPrs(db, done, planB, TEST_REPO_MAP, 0);
    updatePlannedPr(db, b1!.id, { state: 'open', prNumber: 40 }, 0);
    github.statuses.set('acme/core#12', { isDraft: false, merged: false, state: 'OPEN', unresolvedThreads: 2, ciState: 'failure' });

    await expect(pollGithub({ db, github }, 500)).resolves.toEqual({ updated: 1 });
    expect(github.statusCalls).toEqual([[{ repo: 'acme/core', number: 12 }]]);
    expect(getPlannedPr(db, a1!.id)).toMatchObject({ isDraft: false, unresolvedThreads: 2, ciState: 'failure', polledAt: 500 });
    expect(getPlannedPr(db, a2!.id)?.polledAt).toBeNull();
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(500);
  });
});
