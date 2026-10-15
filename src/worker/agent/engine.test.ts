import { describe, expect, it } from 'vitest';
import { TransientError } from '@/core/errors';
import { execArgs, PodmanEngine } from './engine';
import type { ProcessOptions, ProcessResult } from './process';

const ok = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false });
const fail = (stderr = 'nope'): ProcessResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false, aborted: false });

function scripted(replies: Record<string, ProcessResult>) {
  const calls: { args: string[]; opts?: ProcessOptions }[] = [];
  const run = async (_cmd: string, args: string[], opts?: ProcessOptions) => {
    calls.push({ args, opts });
    return replies[args.slice(0, 2).join(' ')] ?? replies[args[0]!] ?? ok();
  };
  return { calls, run };
}

describe('execArgs', () => {
  it('passes env by name only, never values', () => {
    const args = execArgs({ container: 'wf-boo-1', workdir: '/work', env: { GH_TOKEN: 'secret-value' }, args: ['git', 'status'] });
    expect(args).toEqual(['exec', '-i', '-w', '/work', '--env', 'GH_TOKEN', 'wf-boo-1', 'git', 'status']);
    expect(args.join(' ')).not.toContain('secret-value');
  });
});

describe('PodmanEngine', () => {
  it('creates the volume and container when missing', async () => {
    const { calls, run } = scripted({ 'volume exists': fail(), 'container exists': fail() });
    const engine = new PodmanEngine('podman', run);
    await expect(engine.ensureContainer('wf-boo-1', 'img')).resolves.toEqual({ created: true });
    expect(calls.map((c) => c.args)).toEqual([
      ['volume', 'exists', 'wf-boo-1'],
      ['volume', 'create', 'wf-boo-1'],
      ['container', 'exists', 'wf-boo-1'],
      ['run', '-d', '--name', 'wf-boo-1', '--userns=keep-id', '-v', 'wf-boo-1:/work', 'img', 'sleep', 'infinity'],
    ]);
  });

  it('starts an existing stopped container', async () => {
    const { calls, run } = scripted({ inspect: ok('false\n') });
    const engine = new PodmanEngine('podman', run);
    await expect(engine.ensureContainer('wf-boo-1', 'img')).resolves.toEqual({ created: false });
    expect(calls.at(-1)?.args).toEqual(['start', 'wf-boo-1']);
  });

  it('passes exec env through the child environment and maps failures to TransientError', async () => {
    const { calls, run } = scripted({ 'cp /tmp/x': fail('no such container') });
    const engine = new PodmanEngine('podman', run);
    await engine.exec({ container: 'c', env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, args: ['claude', '--version'] });
    expect(calls[0]?.opts?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
    await expect(engine.copyInto('c', '/tmp/x', '/work/x')).rejects.toBeInstanceOf(TransientError);
  });
  it('stops the command inside the container after an abort or timeout, best effort', async () => {
    const aborted = { ...ok(), aborted: true };
    const first = scripted({ exec: aborted });
    await new PodmanEngine('podman', first.run).exec({ container: 'c', args: ['claude'] });
    expect(first.calls.map((c) => c.args)).toEqual([
      ['exec', '-i', 'c', 'claude'],
      ['exec', 'c', 'pkill', '-TERM', '-f', 'claude'],
    ]);
    const second = scripted({});
    await new PodmanEngine('podman', second.run).exec({ container: 'c', args: ['claude'] });
    expect(second.calls).toHaveLength(1);
  });
});
