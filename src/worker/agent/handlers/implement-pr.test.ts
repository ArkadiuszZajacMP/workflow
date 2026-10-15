import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createPlannedPrs, getPlannedPr, listPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { implementPrHandler } from './implement-pr';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(breakdown = [{ repo: 'core', scope: 'Add field' }, { repo: 'web', scope: 'Show field' }]) {
  const env = makeAgentDeps(db);
  const item = seedItem(db, {
    linearIssueId: 'i1',
    linearIdentifier: 'BOO-7',
    linearUrl: 'https://linear.app/x/BOO-7',
    workState: 'implementing',
    category: 'in_progress',
  });
  env.linear.details.set('i1', { id: 'i1', identifier: 'BOO-7', title: 'Add field', url: 'https://linear.app/x/BOO-7', description: 'Need a field', comments: [] });
  const plan = savePlan(db, item.id, { body: 'Approach: add it', breakdown }, 'claude', null, 0);
  const prs = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
  enqueueJob(db, 'implement-pr', item.id, { plannedPrId: prs[0]!.id }, 0);
  return { ...env, item, prs, job: claimNextJob(db, 0)! };
}
/** The PR appears on GitHub only once Claude has run, as in real life; otherwise the restart check would skip Claude. */
function openPrWhenClaudeRuns(env: ReturnType<typeof setup>, repo: string, number: number, branch: string) {
  const original = env.engine.exec.bind(env.engine);
  env.engine.exec = async (req) => {
    if (isClaudeExec(req)) env.github.addOpenPr(repo, number, branch);
    return original(req);
  };
}
const queued = () => db.select().from(jobs).all().filter((j) => j.status === 'queued');

describe('implementPrHandler', () => {
  it('implements PR 1, verifies it on GitHub and queues PR 2', async () => {
    const s = setup();
    const { deps, engine, item, prs, job } = s;
    openPrWhenClaudeRuns(s, 'acme/core', 12, 'boo-7-add-field');
    engine.replyClaude({ prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', branch: 'boo-7-add-field', summary: 'Adds the field' });
    await implementPrHandler(deps, job);

    expect(getPlannedPr(db, prs[0]!.id)).toMatchObject({ state: 'open', prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', isDraft: true });
    expect(queued()).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[1]!.id } }]);
    expect(getItem(db, item.id)?.workState).toBe('implementing');
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-token', GH_TOKEN: 'gh-token', CODEARTIFACT_AUTH_TOKEN: 'ca-token' });
    expect(exec.args[0]).toBe('sh');
    const prompt = exec.stdin!;
    expect(prompt).toContain('PR 1 of 2');
    expect(prompt).toContain('Branch to create: boo-7-add-field');
    expect(prompt).toContain('yarn lint:quiet');
  });

  it('moves the item to verification after the last PR', async () => {
    const s = setup([{ repo: 'web', scope: 'Show field' }]);
    const { deps, engine, item, job } = s;
    openPrWhenClaudeRuns(s, 'acme/web', 3, 'boo-7-show-field');
    engine.replyClaude({ prNumber: 3, prUrl: 'https://github.com/acme/web/pull/3', branch: 'boo-7-show-field', summary: 'UI' });
    await implementPrHandler(deps, job);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', category: 'verification' });
    expect(queued()).toHaveLength(0);
  });

  it('reuses an already-open PR for the branch after a restart instead of running Claude again', async () => {
    const { deps, engine, github, prs, job } = setup();
    github.addOpenPr('acme/core', 12, 'boo-7-add-field');
    await implementPrHandler(deps, job);
    expect(engine.execs.some(isClaudeExec)).toBe(false);
    expect(getPlannedPr(db, prs[0]!.id)).toMatchObject({ state: 'open', prNumber: 12 });
  });

  it('fails permanently when the reported PR does not exist on GitHub', async () => {
    const { deps, engine, job } = setup();
    engine.replyClaude({ prNumber: 99, prUrl: 'https://github.com/acme/core/pull/99', branch: 'boo-7-add-field', summary: 'x' });
    const err = await implementPrHandler(deps, job).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('GitHub shows no open PR #99');
  });

  it('records the PR but starts no further work when dismissed during the run', async () => {
    const s = setup();
    const { deps, engine, item, prs, job } = s;
    openPrWhenClaudeRuns(s, 'acme/core', 12, 'boo-7-add-field');
    engine.replyClaude({ prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', branch: 'boo-7-add-field', summary: 'x' });
    const original = engine.exec.bind(engine);
    engine.exec = async (req) => {
      if (isClaudeExec(req)) updateItem(db, item.id, { category: 'dismissed' });
      return original(req);
    };
    await implementPrHandler(deps, job);
    expect(getPlannedPr(db, prs[0]!.id)?.state).toBe('open');
    expect(queued()).toHaveLength(0);
    expect(listPlannedPrs(db, item.id)[1]?.state).toBe('pending');
  });

  it('does not queue PR 2 again when PR 1 is already open and PR 2 already has an active job', async () => {
    const { deps, engine, prs, job } = setup();
    updatePlannedPr(db, prs[0]!.id, { state: 'open', prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', isDraft: true }, 0);
    enqueueJob(db, 'implement-pr', job.itemId, { plannedPrId: prs[1]!.id }, 0);
    await implementPrHandler(deps, job);
    expect(engine.execs.some(isClaudeExec)).toBe(false);
    expect(queued().filter((j) => (j.payload as { plannedPrId: number }).plannedPrId === prs[1]!.id)).toHaveLength(1);
  });

  it('does nothing for an item dismissed before the run', async () => {
    const { deps, engine, item, job } = setup();
    updateItem(db, item.id, { category: 'dismissed' });
    await implementPrHandler(deps, job);
    expect(engine.execs.some(isClaudeExec)).toBe(false);
    expect(queued()).toHaveLength(0);
  });

  it('fails permanently and does not mark the PR open when the PR is on a different branch', async () => {
    const s = setup();
    const { deps, engine, prs, job } = s;
    openPrWhenClaudeRuns(s, 'acme/core', 12, 'some-other-branch');
    engine.replyClaude({ prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', branch: 'boo-7-add-field', summary: 'x' });
    const err = await implementPrHandler(deps, job).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(getPlannedPr(db, prs[0]!.id)?.state).not.toBe('open');
  });
});
