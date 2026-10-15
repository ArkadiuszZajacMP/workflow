import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { savePlan } from './plans';
import {
  allPrsOpen,
  branchName,
  createPlannedPrs,
  listPlannedPrs,
  nextPendingPr,
  prRollup,
  updatePlannedPr,
} from './planned-prs';

describe('branchName', () => {
  it('builds {team}-{number}-{slug} in lowercase, max 40 slug chars', () => {
    expect(branchName('BOO-1430', 'Scope raw-body parser to /webhooks!')).toBe('boo-1430-scope-raw-body-parser-to-webhooks');
    expect(branchName('BOO-1', '***')).toBe('boo-1-change');
    expect(branchName('BOO-2', 'a'.repeat(60))).toBe(`boo-2-${'a'.repeat(40)}`);
  });
});

describe('planned PRs', () => {
  function setup() {
    const db = createTestDb();
    const item = seedItem(db, { linearIdentifier: 'BOO-7', linearIssueId: 'i7' });
    const plan = savePlan(
      db,
      item.id,
      {
        body: 'b',
        breakdown: [
          { repo: 'core', scope: 'Add field' },
          { repo: 'web', scope: 'Add field' },
        ],
      },
      'claude',
      null,
      1,
    );
    return { db, item, plan };
  }

  it('creates one row per breakdown entry with unique branches', () => {
    const { db, item, plan } = setup();
    const rows = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5);
    expect(rows.map((r) => [r.position, r.repoKey, r.githubRepo, r.branch, r.state])).toEqual([
      [1, 'core', 'acme/core', 'boo-7-add-field', 'pending'],
      [2, 'web', 'acme/web', 'boo-7-add-field-2', 'pending'],
    ]);
    expect(nextPendingPr(db, item.id)?.position).toBe(1);
  });

  it('refuses unknown repositories', () => {
    const { db, item } = setup();
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'mobile', scope: 'x' }] }, 'user', null, 2);
    expect(() => createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5)).toThrow(PermanentError);
  });

  it('knows when every PR is open', () => {
    const { db, item, plan } = setup();
    const [a, b] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5);
    expect(allPrsOpen(db, item.id)).toBe(false);
    updatePlannedPr(db, a!.id, { state: 'open', prNumber: 1 }, 6);
    expect(nextPendingPr(db, item.id)?.id).toBe(b!.id);
    updatePlannedPr(db, b!.id, { state: 'open', prNumber: 2 }, 7);
    expect(allPrsOpen(db, item.id)).toBe(true);
    expect(listPlannedPrs(db, item.id).map((p) => p.prNumber)).toEqual([1, 2]);
  });
});

describe('prRollup', () => {
  const pr = (state: 'pending' | 'open', ciState: 'none' | 'pending' | 'success' | 'failure', unresolvedThreads = 0) => ({
    state,
    ciState,
    unresolvedThreads,
  });

  it('counts opened PRs and sums unresolved threads of open PRs', () => {
    expect(prRollup([pr('open', 'success', 2), pr('open', 'success', 1), pr('pending', 'none', 9)])).toEqual({
      planned: 3,
      opened: 2,
      ci: 'success',
      unresolved: 3,
    });
  });

  it('ranks failure over pending over success and ignores PRs without checks', () => {
    expect(prRollup([pr('open', 'success'), pr('open', 'failure'), pr('open', 'pending')]).ci).toBe('failure');
    expect(prRollup([pr('open', 'success'), pr('open', 'pending')]).ci).toBe('pending');
    expect(prRollup([pr('open', 'success'), pr('open', 'none')]).ci).toBe('success');
    expect(prRollup([pr('open', 'none'), pr('pending', 'none')]).ci).toBe('none');
    expect(prRollup([])).toEqual({ planned: 0, opened: 0, ci: 'none', unresolved: 0 });
  });
});
