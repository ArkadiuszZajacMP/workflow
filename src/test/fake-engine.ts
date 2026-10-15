import type { ContainerEngine, ExecRequest } from '@/worker/agent/engine';
import type { ProcessResult } from '@/worker/agent/process';

export type FakeReply = {
  exitCode?: number;
  lines?: string[];
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
  signal?: NodeJS.Signals;
};

export function isClaudeExec(req: ExecRequest): boolean {
  return req.args.includes('claude');
}

/** A successful `claude -p --output-format stream-json` transcript whose final result is `output` as JSON. */
export function claudeStream(output: unknown, sessionId = 's-1'): string[] {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }),
  ];
}

export class FakeEngine implements ContainerEngine {
  images = new Set<string>();
  containers = new Set<string>();
  /**
   * Paths that `test -d <path>` reports as existing. `git clone <url> <dest>` adds `<dest>/.git`, and
   * `git -C <dest> rev-parse` succeeds while `<dest>/.git` is present.
   */
  dirs = new Set<string>();
  /** Paths (`<repo dir>/<file>`) that `git -C <dir> ls-files --error-unmatch <file>` reports as tracked. */
  trackedFiles = new Set<string>();
  built: string[] = [];
  removed: string[] = [];
  copies: { container: string; hostPath: string; containerPath: string }[] = [];
  execs: ExecRequest[] = [];
  private rules: { match: (req: ExecRequest) => boolean; reply: FakeReply; once: boolean }[] = [];
  private claudeQueue: FakeReply[] = [];
  private sessions = 0;

  on(match: (req: ExecRequest) => boolean, reply: FakeReply, once = false): this {
    this.rules.push({ match, reply, once });
    return this;
  }

  replyClaude(...outputs: (unknown | FakeReply)[]): this {
    for (const output of outputs) {
      const isReply = typeof output === 'object' && output !== null && ('lines' in output || 'exitCode' in output || 'timedOut' in output || 'aborted' in output);
      this.claudeQueue.push(isReply ? (output as FakeReply) : { lines: claudeStream(output, `s-${++this.sessions}`) });
    }
    return this;
  }

  async imageExists(image: string) {
    return this.images.has(image);
  }

  async buildImage(image: string) {
    this.built.push(image);
    this.images.add(image);
  }

  async ensureContainer(name: string) {
    const created = !this.containers.has(name);
    this.containers.add(name);
    return { created };
  }

  async exec(req: ExecRequest): Promise<ProcessResult> {
    this.execs.push(req);
    const index = this.rules.findIndex((r) => r.match(req));
    let reply: FakeReply | undefined;
    if (index >= 0) {
      reply = this.rules[index]!.reply;
      if (this.rules[index]!.once) this.rules.splice(index, 1);
    } else if (isClaudeExec(req) && this.claudeQueue.length > 0) {
      reply = this.claudeQueue.shift();
    } else if (req.args[0] === 'test' && req.args[1] === '-d') {
      reply = { exitCode: this.dirs.has(req.args[2]!) ? 0 : 1 };
    } else if (req.args[0] === 'git' && req.args[1] === '-C' && req.args[3] === 'rev-parse') {
      reply = { exitCode: this.dirs.has(`${req.args[2]}/.git`) ? 0 : 1 };
    } else if (req.args[0] === 'git' && req.args[1] === '-C' && req.args[3] === 'ls-files') {
      reply = { exitCode: this.trackedFiles.has(`${req.args[2]}/${req.args.at(-1)}`) ? 0 : 1 };
    } else if (req.args[0] === 'rm' && req.args[1] === '-rf') {
      for (const d of [...this.dirs]) if (d === req.args[2] || d.startsWith(`${req.args[2]}/`)) this.dirs.delete(d);
    } else if (req.args[0] === 'git' && req.args[1] === 'clone') {
      this.dirs.add(`${req.args[3]}/.git`);
    }
    for (const line of reply?.lines ?? []) req.onLine?.(line);
    return {
      exitCode: reply?.exitCode ?? 0,
      stdout: (reply?.lines ?? []).join('\n'),
      stderr: reply?.stderr ?? '',
      timedOut: reply?.timedOut ?? false,
      aborted: reply?.aborted ?? false,
      signal: reply?.signal ?? null,
    };
  }

  async copyInto(container: string, hostPath: string, containerPath: string) {
    this.copies.push({ container, hostPath, containerPath });
  }

  async remove(name: string) {
    this.removed.push(name);
    this.containers.delete(name);
  }
}
