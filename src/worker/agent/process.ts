import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { TransientError } from '@/core/errors';

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process was ended by a signal rather than exiting on its own. */
  signal?: NodeJS.Signals | null;
};
export type ProcessOptions = {
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  cwd?: string;
  /** Time between SIGTERM and SIGKILL. Defaults to KILL_GRACE_MS. */
  killGraceMs?: number;
};
export type Runner = (cmd: string, args: string[], opts?: ProcessOptions) => Promise<ProcessResult>;

export const KILL_GRACE_MS = 10_000;

/**
 * Children run in their own process group (`detached`), so a terminal Ctrl-C reaches only the worker,
 * which then stops them in order (abort → SIGTERM → SIGKILL) instead of having them die mid-run.
 */
export function spawnOptions(opts: ProcessOptions): SpawnOptionsWithoutStdio {
  // stdio defaults to pipes for all three streams.
  return { env: { ...process.env, ...opts.env }, cwd: opts.cwd, detached: true };
}

/** Live children, killed when the worker exits so detached children never outlive it. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  }
}

function track(child: ChildProcess): void {
  live.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const c of live) signalGroup(c, 'SIGKILL');
  });
}

/** Runs a host process. Secrets go in `env` (merged over process.env), never in `args`. */
export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, spawnOptions(opts));
    track(child);
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      if (killTimer) return;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      live.delete(child);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      stdout += text;
      if (!opts.onLine) return;
      pending += text;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line) opts.onLine(line);
        index = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', (err) => {
      cleanup();
      reject(new TransientError(`Could not start ${cmd}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (opts.onLine && pending) opts.onLine(pending);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, aborted, signal: signal ?? null });
    });
    child.stdin.on('error', () => {
      // The child may exit before reading stdin; that is not an error for us.
    });
    child.stdin.end(opts.stdin ?? '');
  });
