import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { createHostTools } from './host';
import type { ProcessOptions, ProcessResult } from './process';

const result = (exitCode: number, stdout = '', stderr = ''): ProcessResult => ({ exitCode, stdout, stderr, timedOut: false, aborted: false });

describe('createHostTools', () => {
  it('reads the host git identity', async () => {
    const run = async (_cmd: string, args: string[]) => result(0, args.includes('user.name') ? 'Arek Z\n' : 'arek@example.com\n');
    const host = createHostTools({ run, dockerSkillDir: '/d', meetingpackageSkillDir: '/m' });
    await expect(host.gitIdentity()).resolves.toEqual({ name: 'Arek Z', email: 'arek@example.com' });
    const missing = createHostTools({ run: async () => result(1), dockerSkillDir: '/d', meetingpackageSkillDir: '/m' });
    await expect(missing.gitIdentity()).rejects.toBeInstanceOf(PermanentError);
  });

  it('runs sync-env and returns the private env directory when it exists', async () => {
    const dockerSkillDir = mkdtempSync(path.join(tmpdir(), 'docker-skill-'));
    mkdirSync(path.join(dockerSkillDir, 'private', 'env', 'core', 'development'), { recursive: true });
    const calls: string[][] = [];
    const host = createHostTools({
      run: async (_cmd, args) => {
        calls.push(args);
        return result(0);
      },
      dockerSkillDir,
      meetingpackageSkillDir: '/m',
    });
    await expect(host.syncEnv('core', 'development')).resolves.toBe(path.join(dockerSkillDir, 'private', 'env', 'core', 'development'));
    expect(calls[0]).toEqual([path.join(dockerSkillDir, 'scripts', 'sync-env.sh'), '--repo', 'core', '--env', 'development']);
    await expect(host.syncEnv('web', 'development')).resolves.toBeNull();
  });

  it('detects a repository through the meetingpackage script, null when ambiguous', async () => {
    const seen: ProcessOptions[] = [];
    let code = 0;
    const host = createHostTools({
      run: async (_cmd, _args, opts) => {
        seen.push(opts ?? {});
        return result(code, code === 0 ? 'core\n' : '', code === 0 ? '' : 'ambiguous');
      },
      dockerSkillDir: '/d',
      meetingpackageSkillDir: '/m',
    });
    const issue = { identifier: 'BOO-1', title: 'core-api drops bodies', description: 'd', comments: ['c'] };
    await expect(host.detectRepository(issue)).resolves.toBe('core');
    expect(JSON.parse(seen[0]!.stdin!)).toEqual({ identifier: 'BOO-1', title: 'core-api drops bodies', description: 'd', comments: { nodes: [{ body: 'c' }] } });
    code = 1;
    await expect(host.detectRepository(issue)).resolves.toBeNull();
  });
});
