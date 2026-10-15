import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { PermanentError, ShutdownStop, TransientError } from '@/core/errors';
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
    expect(claudeArgs('investigate', { maxTurns: 60, model: null })).toEqual([
      'claude', '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '60', '--allowedTools', INVESTIGATE_TOOLS,
    ]);
    expect(claudeArgs('implement-pr', { maxTurns: 200, model: 'claude-opus-5-5', resume: 's-1' })).toEqual([
      'claude', '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '200', '--dangerously-skip-permissions',
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

  it('sends the prompt on stdin and keeps argv short', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ answer: 1 });
    const prompt = '-x '.concat('a'.repeat(300_000));
    await runAgent(deps, { job, item, kind: 'investigate', prompt, schema, env: {} });
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.stdin).toBe(prompt);
    expect(exec.args).not.toContain(prompt);
    expect(exec.args.every((arg) => arg.length < 1024)).toBe(true);
  });

  it('refuses to give an investigation push or registry tokens', async () => {
    const { deps, engine, item, job } = setup();
    for (const name of ['GH_TOKEN', 'CODEARTIFACT_AUTH_TOKEN']) {
      const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: { [name]: 'x' } }).catch((e) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.message).toBe('Investigation runs must not receive push or registry tokens');
    }
    expect(engine.execs.filter(isClaudeExec)).toHaveLength(0);
    expect(listRuns(db, item.id)).toHaveLength(0);
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
    expect(second.stdin).toMatch(/could not be used/);
    expect(listRuns(db, item.id)).toHaveLength(1);
    expect(readFileSync(listRuns(db, item.id)[0]!.logPath, 'utf8').trim().split('\n')).toHaveLength(6);
    expect(second.args).toContain('--resume');
    expect(second.args).toContain('s-1');

    engine.replyClaude('nope', 'still nope');
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toMatch(/invalid output twice/);
    expect(err.message).not.toContain('\\"');
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
    expect(listRuns(db, item.id).map((r) => r.outcome).sort()).toEqual(['failed', 'timed_out']);
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

  it('ends the run as stopped with a ShutdownStop when the worker shuts down', async () => {
    const { deps, engine, item, job } = setup();
    const shutdown = new AbortController();
    deps.shutdownSignal = shutdown.signal;
    engine.exec = async (req) => {
      shutdown.abort();
      return { exitCode: 143, stdout: '', stderr: '', timedOut: false, aborted: req.signal?.aborted ?? false };
    };
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ShutdownStop);
    expect(listRuns(db, item.id)[0]?.outcome).toBe('stopped');
  });

  it('treats a user Stop as permanent even if the worker is also shutting down', async () => {
    const { deps, engine, item, job } = setup();
    const shutdown = new AbortController();
    deps.shutdownSignal = shutdown.signal;
    engine.exec = async (req) => {
      requestStop(db, job.id);
      shutdown.abort();
      return { exitCode: 143, stdout: '', stderr: '', timedOut: false, aborted: req.signal?.aborted ?? false };
    };
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
  });

  it('treats container exec failures as transient and marks the workspace broken', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ exitCode: 125, lines: [], stderr: 'no such container' });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(getWorkspace(db, item.id)?.status).toBe('broken');
    expect(listRuns(db, item.id)[0]?.outcome).toBe('failed');
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
