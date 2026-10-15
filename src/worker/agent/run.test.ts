import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { PermanentError, TransientError } from '@/core/errors';
import { claimNextJob, enqueueJob, requestStop } from '@/core/jobs/queue';
import { listRuns } from '@/core/work/runs';
import { createWorkspaceRow, getWorkspace } from '@/core/work/workspaces';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { claudeArgs, INVESTIGATE_TOOLS, runAgent } from './run';

const schema = z.object({ answer: z.number(), summary: z.string().optional() });
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(kind: 'investigate' | 'implement-pr' = 'investigate') {
  const env = makeAgentDeps(db);
  const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1' });
  createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 0);
  enqueueJob(db, kind === 'investigate' ? 'investigate' : 'implement-pr', item.id, kind === 'investigate' ? {} : { plannedPrId: 1 }, 0);
  const job = claimNextJob(db, 0)!;
  return { ...env, item, job };
}

describe('claudeArgs', () => {
  it('limits investigation to read-only tools and lets implementation run unattended', () => {
    expect(claudeArgs('investigate', 'P', { maxTurns: 60, model: null })).toEqual([
      'claude', '-p', 'P', '--output-format', 'stream-json', '--verbose', '--max-turns', '60', '--allowedTools', INVESTIGATE_TOOLS,
    ]);
    expect(claudeArgs('implement-pr', 'P', { maxTurns: 200, model: 'claude-opus-5-5', resume: 's-1' })).toEqual([
      'claude', '-p', 'P', '--output-format', 'stream-json', '--verbose', '--max-turns', '200', '--dangerously-skip-permissions',
      '--model', 'claude-opus-5-5', '--resume', 's-1',
    ]);
  });
});

describe('runAgent', () => {
  it('runs claude in the workspace, logs the stream and returns the parsed result', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ answer: 42, summary: 'Found it' });
    await expect(
      runAgent(deps, { job, item, kind: 'investigate', prompt: 'Investigate', schema, env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } }),
    ).resolves.toEqual({ answer: 42, summary: 'Found it' });
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec).toMatchObject({ container: 'wf-boo-1', workdir: '/work', env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } });
    expect(exec.timeoutMs).toBe(20 * 60_000);
    const [run] = listRuns(db, item.id);
    expect(run).toMatchObject({ outcome: 'succeeded', summary: 'Found it', kind: 'investigate' });
    expect(readFileSync(run!.logPath, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('wraps the command with registry auth when a registry is given', async () => {
    const { deps, engine, item, job } = setup('implement-pr');
    engine.replyClaude({ answer: 1 });
    await runAgent(deps, {
      job, item, kind: 'implement-pr', prompt: 'Implement', schema,
      env: { CODEARTIFACT_AUTH_TOKEN: 'ca' }, registry: 'https://reg.example.com/npm/x/',
    });
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.args[0]).toBe('sh');
    expect(exec.args).toContain('--dangerously-skip-permissions');
    expect(exec.timeoutMs).toBe(60 * 60_000);
  });

  it('resumes once when the final message is not valid, then gives up', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude('I could not decide', { answer: 7 });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).resolves.toEqual({ answer: 7 });
    const second = engine.execs.filter(isClaudeExec)[1]!;
    expect(second.args).toContain('--resume');
    expect(second.args).toContain('s-1');

    engine.replyClaude('nope', 'still nope');
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toMatch(/invalid output twice/);
  });

  it('records timeouts and error results as permanent failures', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ timedOut: true, lines: [] });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toThrow(
      'Run timed out after 20 min',
    );
    expect(listRuns(db, item.id)[0]?.outcome).toBe('timed_out');

    engine.replyClaude({
      lines: [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's-9' })],
    });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toThrow(
      'Claude run ended with error_max_turns',
    );
  });

  it('kills the run when a stop is requested', async () => {
    const { deps, engine, item, job } = setup();
    engine.exec = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { exitCode: 143, stdout: '', stderr: '', timedOut: false, aborted: req.signal?.aborted ?? false };
    };
    requestStop(db, job.id);
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Run stopped by user');
    expect(listRuns(db, item.id)[0]?.outcome).toBe('stopped');
  });

  it('treats container exec failures as transient and marks the workspace broken', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ exitCode: 125, lines: [], stderr: 'no such container' });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(getWorkspace(db, item.id)?.status).toBe('broken');
  });

  it('passes the configured model', async () => {
    const { deps, engine, item, job } = setup();
    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, claude: { model: 'claude-opus-5-5' } });
    engine.replyClaude({ answer: 1 });
    await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} });
    expect(engine.execs.find(isClaudeExec)!.args).toContain('claude-opus-5-5');
    expect(existsSync(deps.runsDir)).toBe(true);
  });
});
