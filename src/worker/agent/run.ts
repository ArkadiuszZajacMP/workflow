import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { extractJson } from '@/core/clients/claude';
import type { AgentRunKind, Item, Job } from '@/core/db/schema';
import { errorMessage, PermanentError, TransientError } from '@/core/errors';
import { isStopRequested } from '@/core/jobs/queue';
import { finishRun, startRun } from '@/core/work/runs';
import { parseStreamLine } from '@/core/work/stream';
import { updateWorkspace, workspaceName } from '@/core/work/workspaces';
import { withRegistryAuth } from './codeartifact';
import type { AgentDeps } from './deps';

export const INVESTIGATE_TOOLS =
  'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git diff:*),Bash(ls:*)';
const STOP_POLL_MS = 1_000;
/** podman exec's own failures: container missing, not runnable, command not found. */
const ENGINE_EXIT_CODES = new Set([125, 126, 127]);

export function claudeArgs(
  kind: AgentRunKind,
  prompt: string,
  opts: { maxTurns: number; model: string | null; resume?: string },
): string[] {
  const args = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(opts.maxTurns)];
  if (kind === 'investigate') args.push('--allowedTools', INVESTIGATE_TOOLS);
  else args.push('--dangerously-skip-permissions');
  if (opts.model) args.push('--model', opts.model);
  if (opts.resume) args.push('--resume', opts.resume);
  return args;
}

export type AgentRunRequest<T> = {
  job: Job;
  item: Item;
  plannedPrId?: number | null;
  kind: AgentRunKind;
  prompt: string;
  schema: z.ZodType<T>;
  /** Passed into the container by name only. */
  env: Record<string, string>;
  /** When set, the command runs with npm/yarn auth for this registry (needs CODEARTIFACT_AUTH_TOKEN in env). */
  registry?: string | null;
};

type Final = { ok: boolean; subtype: string; text: string; sessionId: string | null };

class RunEnded extends Error {
  constructor(
    readonly outcome: 'stopped' | 'timed_out',
    message: string,
  ) {
    super(message);
  }
}

function parseResult<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
}

function summarize(value: unknown): string {
  const summary = (value as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.slice(0, 500) : 'Completed';
}

/**
 * Runs one Claude Code session inside the item's container and returns its validated final JSON.
 * Invalid output is resumed once. Timeouts and stops are permanent failures; podman exec failures are transient.
 */
export async function runAgent<T>(deps: AgentDeps, req: AgentRunRequest<T>): Promise<T> {
  if (!req.item.linearIdentifier) throw new PermanentError(`Item #${req.item.id} has no Linear issue`);
  const cfg = deps.config.agent;
  const investigate = req.kind === 'investigate';
  const timeoutMs = (investigate ? cfg.timeoutMinutes.investigate : cfg.timeoutMinutes.implement) * 60_000;
  const maxTurns = investigate ? cfg.maxTurns.investigate : cfg.maxTurns.implement;
  const container = workspaceName(req.item.linearIdentifier);
  mkdirSync(deps.runsDir, { recursive: true });
  const logPath = path.join(deps.runsDir, `${req.job.id}-${deps.now()}.jsonl`);
  const run = startRun(
    deps.db,
    { jobId: req.job.id, itemId: req.item.id, plannedPrId: req.plannedPrId ?? null, kind: req.kind, logPath },
    deps.now(),
  );
  const controller = new AbortController();
  const stopTimer = setInterval(() => {
    if (isStopRequested(deps.db, req.job.id)) controller.abort();
  }, STOP_POLL_MS);

  const exec = async (prompt: string, resume?: string): Promise<Final> => {
    const base = claudeArgs(req.kind, prompt, { maxTurns, model: deps.config.claude.model, resume });
    const seen: { final: Final | null } = { final: null };
    const result = await deps.engine.exec({
      container,
      workdir: '/work',
      env: req.env,
      args: req.registry ? withRegistryAuth(base, req.registry) : base,
      timeoutMs,
      signal: controller.signal,
      onLine: (line) => {
        appendFileSync(logPath, `${line}\n`);
        for (const event of parseStreamLine(line)) if (event.type === 'result') seen.final = event;
      },
    });
    if (result.aborted) throw new RunEnded('stopped', 'Run stopped by user');
    if (result.timedOut) throw new RunEnded('timed_out', `Run timed out after ${timeoutMs / 60_000} min`);
    const final = seen.final;
    if (!final) {
      if (ENGINE_EXIT_CODES.has(result.exitCode)) {
        updateWorkspace(deps.db, req.item.id, { status: 'broken' }, deps.now());
        throw new TransientError(`Container exec failed (${result.exitCode}): ${result.stderr.trim().slice(-300)}`);
      }
      throw new PermanentError(`Claude exited with ${result.exitCode} without a result: ${result.stderr.trim().slice(-300)}`);
    }
    if (!final.ok) throw new PermanentError(`Claude run ended with ${final.subtype}${final.text ? `: ${final.text.slice(0, 300)}` : ''}`);
    return final;
  };

  try {
    const first = await exec(req.prompt);
    let parsed = parseResult(first.text, req.schema);
    if (!parsed.ok) {
      if (!first.sessionId) throw new PermanentError(`Claude returned invalid output: ${parsed.error}`);
      const second = await exec(
        `Your final message could not be used: ${parsed.error}\nReply again with only the JSON object described in the task.`,
        first.sessionId,
      );
      parsed = parseResult(second.text, req.schema);
      if (!parsed.ok) throw new PermanentError(`Claude returned invalid output twice: ${parsed.error}`);
    }
    finishRun(deps.db, run.id, 'succeeded', summarize(parsed.value), deps.now());
    return parsed.value;
  } catch (err) {
    if (err instanceof RunEnded) {
      finishRun(deps.db, run.id, err.outcome, err.message, deps.now());
      throw new PermanentError(err.message);
    }
    finishRun(deps.db, run.id, 'failed', errorMessage(err).slice(0, 500), deps.now());
    throw err;
  } finally {
    clearInterval(stopTimer);
  }
}
