import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
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

    await expect(pollGithub({ db, github }, 500)).resolves.toEqual({ updated: 1, failed: 0 });
    expect(github.statusCalls).toEqual([[{ repo: 'acme/core', number: 12 }]]);
    expect(getPlannedPr(db, a1!.id)).toMatchObject({ isDraft: false, unresolvedThreads: 2, ciState: 'failure', polledAt: 500 });
    expect(getPlannedPr(db, a2!.id)?.polledAt).toBeNull();
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(500);
  });

  it('keeps updates from healthy repos when one repo fails and records the error', async () => {
    const db = createTestDb();
    const github = new FakeGitHub();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }, { repo: 'web', scope: 'y' }] }, 'user', null, 0);
    const [p1, p2] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    updatePlannedPr(db, p1!.id, { state: 'open', prNumber: 1 }, 0);
    updatePlannedPr(db, p2!.id, { state: 'open', prNumber: 2 }, 0);
    const ok = { isDraft: false, merged: false, state: 'OPEN', unresolvedThreads: 0, ciState: 'success' } as const;
    github.statuses.set('acme/core#1', ok);
    github.statuses.set('acme/web#2', ok);
    github.failures.prStatuses = new PermanentError('FORBIDDEN: SSO required');

    await expect(pollGithub({ db, github }, 700)).resolves.toEqual({ updated: 1, failed: 1 });
    const polled = [getPlannedPr(db, p1!.id)?.polledAt, getPlannedPr(db, p2!.id)?.polledAt];
    expect(polled.filter((v) => v === 700)).toHaveLength(1);
    const cursor = getCursor(db, 'github');
    expect(cursor?.lastError).toMatch(/FORBIDDEN: SSO required \(1 PR\(s\) skipped\)/);
    expect(cursor?.lastSuccessAt ?? null).toBeNull();
  });

  it('skips merged PRs and items that are done or dismissed', async () => {
    const db = createTestDb();
    const github = new FakeGitHub();
    const merged = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const closed = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-2', workState: 'prs_open', category: 'done' });
    for (const [item, n] of [[merged, 1], [closed, 2]] as const) {
      const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
      const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
      updatePlannedPr(db, pr!.id, { state: 'open', prNumber: n, merged: item === merged }, 0);
    }
    await expect(pollGithub({ db, github }, 1)).resolves.toEqual({ updated: 0, failed: 0 });
    expect(github.statusCalls).toEqual([]);
  });

  it('delays the next attempt by a longer Retry-After', async () => {
    const db = createTestDb();
    const github = new FakeGitHub();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
    const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    updatePlannedPr(db, pr!.id, { state: 'open', prNumber: 1 }, 0);
    github.failures.prStatuses = new TransientError('rate limited', 600_000);
    await pollGithub({ db, github, intervalMs: 120_000 }, 1000);
    expect(getCursor(db, 'github')?.lastErrorAt).toBe(1000 + 480_000);
  });
});
