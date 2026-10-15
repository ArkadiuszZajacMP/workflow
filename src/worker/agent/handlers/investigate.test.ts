import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { PermanentError } from '@/core/errors';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { latestPlan, savePlan } from '@/core/work/plans';
import { getWorkspace } from '@/core/work/workspaces';
import { configSchema } from '@/core/config/schema';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { investigateHandler } from './investigate';

const output = {
  body: '## Findings\nParser disabled.\n## Approach\nScope it.\n## Risks\nNone.',
  breakdown: [{ repo: 'core', scope: 'Scope the raw-body parser to webhook routes' }],
  summary: 'One PR in core',
};
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(payload: { feedback?: string } = {}, ids = { issueId: 'i1', identifier: 'BOO-1430' }) {
  const env = makeAgentDeps(db);
  const item = seedItem(db, { linearIssueId: ids.issueId, linearIdentifier: ids.identifier, workState: 'investigating', title: 'Bodies dropped' });
  env.linear.details.set(ids.issueId, {
    id: ids.issueId,
    identifier: ids.identifier,
    title: 'core-api drops every JSON request body',
    url: 'https://linear.app/x/BOO-1430',
    description: 'Every POST body arrives empty.',
    comments: [],
  });
  enqueueJob(db, 'investigate', item.id, payload, 0);
  return { ...env, item, job: claimNextJob(db, 0)! };
}

describe('investigateHandler', () => {
  it('investigates read-only and saves a plan', async () => {
    const { deps, engine, host, item, job } = setup();
    engine.replyClaude(output);
    await investigateHandler(deps, job);

    expect(latestPlan(db, item.id)).toMatchObject({ version: 1, author: 'claude', breakdown: output.breakdown });
    expect(getItem(db, item.id)?.workState).toBe('plan_ready');
    expect(getWorkspace(db, item.id)?.repos).toEqual(['core']);
    expect(host.detectCalls).toHaveLength(1);
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' });
    expect(exec.args).toContain('--allowedTools');
    expect(exec.args).not.toContain('--dangerously-skip-permissions');
    const prompt = exec.stdin!;
    expect(prompt).toContain('Every POST body arrives empty.');
    expect(prompt).toContain('- core (/work/core)');
    expect(prompt).toContain('Repository keys you may use in the breakdown: core, web, infra');
  });

  it('includes Linear comments in the prompt', async () => {
    const { deps, engine, job, linear } = setup();
    linear.details.get('i1')!.comments = ['Seen on staging too'];
    engine.replyClaude(output);
    await investigateHandler(deps, job);
    expect(engine.execs.find(isClaudeExec)!.stdin).toContain('Seen on staging too');
  });

  it('revises using the previous plan, its repos and the feedback', async () => {
    const { deps, engine, host, item, job } = (() => {
      const env = setup({ feedback: 'split the UI change out' });
      savePlan(db, env.item.id, { body: 'old body', breakdown: [{ repo: 'web', scope: 'old scope' }] }, 'claude', null, 0);
      return env;
    })();
    engine.replyClaude(output);
    await investigateHandler(deps, job);
    expect(host.detectCalls).toHaveLength(0);
    expect(getWorkspace(db, item.id)?.repos).toEqual(['web']);
    const prompt = engine.execs.find(isClaudeExec)!.stdin!;
    expect(prompt).toContain('old scope');
    expect(prompt).toContain('split the UI change out');
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, feedback: 'split the UI change out' });
  });

  it('falls back to defaultRepos and fails clearly when no repository is known', async () => {
    const { deps, host, job } = setup();
    host.detected = null;
    await expect(investigateHandler(deps, job)).rejects.toThrow(/No repository detected/);

    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { defaultRepos: ['infra'] } });
    const second = setup({}, { issueId: 'i2', identifier: 'BOO-1431' });
    second.host.detected = null;
    second.deps.config = deps.config;
    second.engine.replyClaude({ ...output, breakdown: [{ repo: 'infra', scope: 'x' }] });
    await investigateHandler(second.deps, second.job);
    expect(getWorkspace(db, second.item.id)?.repos).toEqual(['infra']);
  });

  it('rejects breakdowns with unknown repos after one resume', async () => {
    const { deps, engine, job } = setup();
    const bad = { ...output, breakdown: [{ repo: 'mobile', scope: 'x' }] };
    engine.replyClaude(bad, bad);
    const err = await investigateHandler(deps, job).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('unknown repository "mobile"');
  });

  it('does nothing for a dismissed item, and saves nothing if dismissed during the run', async () => {
    const first = setup();
    updateItem(db, first.item.id, { category: 'dismissed' });
    await investigateHandler(first.deps, first.job);
    expect(first.engine.execs).toHaveLength(0);

    const second = setup({}, { issueId: 'i2', identifier: 'BOO-1431' });
    second.engine.replyClaude(output);
    const original = second.engine.exec.bind(second.engine);
    second.engine.exec = async (req) => {
      if (isClaudeExec(req)) updateItem(db, second.item.id, { category: 'dismissed' });
      return original(req);
    };
    await investigateHandler(second.deps, second.job);
    expect(latestPlan(db, second.item.id)).toBeUndefined();
  });
});
