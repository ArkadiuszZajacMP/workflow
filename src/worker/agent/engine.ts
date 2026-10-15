import { TransientError } from '@/core/errors';
import { type ProcessOptions, type ProcessResult, type Runner, runProcess } from './process';

export type ExecRequest = {
  container: string;
  workdir?: string;
  /** Passed as `--env NAME`; the value travels in the podman process environment, never in argv. */
  env?: Record<string, string>;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
};

export interface ContainerEngine {
  imageExists(image: string): Promise<boolean>;
  buildImage(image: string, contextDir: string): Promise<void>;
  /** Creates the named volume and container if missing, starts it if stopped. */
  ensureContainer(name: string, image: string): Promise<{ created: boolean }>;
  exec(req: ExecRequest): Promise<ProcessResult>;
  copyInto(container: string, hostPath: string, containerPath: string): Promise<void>;
  /** Removes the container and its volume. Missing ones are ignored. */
  remove(name: string): Promise<void>;
}

export function execArgs(req: ExecRequest): string[] {
  const args = ['exec', '-i'];
  if (req.workdir) args.push('-w', req.workdir);
  for (const key of Object.keys(req.env ?? {})) args.push('--env', key);
  return [...args, req.container, ...req.args];
}

export class PodmanEngine implements ContainerEngine {
  constructor(
    private readonly cmd = 'podman',
    private readonly run: Runner = runProcess,
  ) {}

  private async must(args: string[], opts?: ProcessOptions): Promise<ProcessResult> {
    const result = await this.run(this.cmd, args, opts);
    if (result.exitCode !== 0) {
      throw new TransientError(`${this.cmd} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  }

  async imageExists(image: string): Promise<boolean> {
    return (await this.run(this.cmd, ['image', 'exists', image])).exitCode === 0;
  }

  async buildImage(image: string, contextDir: string): Promise<void> {
    await this.must(['build', '-t', image, contextDir], { timeoutMs: 30 * 60_000 });
  }

  async ensureContainer(name: string, image: string): Promise<{ created: boolean }> {
    if ((await this.run(this.cmd, ['volume', 'exists', name])).exitCode !== 0) await this.must(['volume', 'create', name]);
    if ((await this.run(this.cmd, ['container', 'exists', name])).exitCode !== 0) {
      await this.must(['run', '-d', '--name', name, '--userns=keep-id', '-v', `${name}:/work`, image, 'sleep', 'infinity']);
      return { created: true };
    }
    const state = await this.must(['inspect', '-f', '{{.State.Running}}', name]);
    if (state.stdout.trim() !== 'true') await this.must(['start', name]);
    return { created: false };
  }

  async exec(req: ExecRequest): Promise<ProcessResult> {
    const result = await this.run(this.cmd, execArgs(req), {
      env: req.env,
      stdin: req.stdin,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: req.onLine,
    });
    if (result.timedOut || result.aborted) {
      // Killing the host `podman exec` client does not stop the command inside the container.
      await this.run(this.cmd, ['exec', req.container, 'pkill', '-TERM', '-f', 'claude']).catch(() => undefined);
    }
    return result;
  }

  async copyInto(container: string, hostPath: string, containerPath: string): Promise<void> {
    await this.must(['cp', hostPath, `${container}:${containerPath}`]);
  }

  async remove(name: string): Promise<void> {
    await this.run(this.cmd, ['rm', '-f', name]);
    await this.run(this.cmd, ['volume', 'rm', '-f', name]);
  }
}
