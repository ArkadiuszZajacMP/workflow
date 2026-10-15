import { existsSync } from 'node:fs';
import path from 'node:path';
import { PermanentError } from '@/core/errors';
import type { Runner } from './process';

export interface HostTools {
  gitIdentity(): Promise<{ name: string; email: string }>;
  /** Runs the docker skill's sync-env.sh and returns the directory holding the env files, or null. Never reads them. */
  syncEnv(repoKey: string, envName: string): Promise<string | null>;
  detectRepository(issue: { identifier: string; title: string; description: string; comments: string[] }): Promise<string | null>;
}

export function createHostTools(opts: { run: Runner; dockerSkillDir: string; meetingpackageSkillDir: string }): HostTools {
  async function gitConfig(key: string): Promise<string> {
    const result = await opts.run('git', ['config', '--global', key]);
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || !value) throw new PermanentError(`Host git ${key} is not set. Run: git config --global ${key} "…"`);
    return value;
  }

  return {
    async gitIdentity() {
      return { name: await gitConfig('user.name'), email: await gitConfig('user.email') };
    },

    async syncEnv(repoKey, envName) {
      const script = path.join(opts.dockerSkillDir, 'scripts', 'sync-env.sh');
      const result = await opts.run('bash', [script, '--repo', repoKey, '--env', envName], { timeoutMs: 5 * 60_000 });
      if (result.exitCode !== 0) {
        throw new PermanentError(`sync-env.sh failed for ${repoKey}: ${(result.stderr || result.stdout).trim()}`);
      }
      const dir = path.join(opts.dockerSkillDir, 'private', 'env', repoKey, envName);
      return existsSync(dir) ? dir : null;
    },

    async detectRepository(issue) {
      const script = path.join(opts.meetingpackageSkillDir, 'scripts', 'detect-repository.sh');
      const payload = {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        comments: { nodes: issue.comments.map((body) => ({ body })) },
      };
      const result = await opts.run('bash', [script, '-'], { stdin: JSON.stringify(payload), timeoutMs: 60_000 });
      const key = result.stdout.trim();
      return result.exitCode === 0 && key ? key : null;
    },
  };
}
