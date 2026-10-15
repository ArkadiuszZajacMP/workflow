import { spawn } from 'node:child_process';
import { TransientError } from '@/core/errors';

export type ProcessResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };
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

/** Runs a host process. Secrets go in `env` (merged over process.env), never in `args`. */
export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      if (killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS);
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
    child.on('close', (code) => {
      cleanup();
      if (opts.onLine && pending) opts.onLine(pending);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, aborted });
    });
    child.stdin.on('error', () => {
      // The child may exit before reading stdin; that is not an error for us.
    });
    child.stdin.end(opts.stdin ?? '');
  });
