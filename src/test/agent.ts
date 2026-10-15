import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '@/core/db/client';
import { CodeArtifactTokens } from '@/worker/agent/codeartifact';
import type { AgentDeps } from '@/worker/agent/deps';
import { FakeEngine } from './fake-engine';
import { FakeGitHub, FakeHost, FakeLinear, TEST_CONFIG } from './fakes';
import { TEST_REPO_MAP } from './repo-map';

export function makeAgentDeps(db: Db) {
  const engine = new FakeEngine();
  const github = new FakeGitHub();
  const linear = new FakeLinear();
  const host = new FakeHost();
  const awsCalls: string[][] = [];
  const codeArtifact = new CodeArtifactTokens(async (_cmd, args) => {
    awsCalls.push(args);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ authorizationToken: 'ca-token', expiration: '2999-01-01T00:00:00Z' }),
      stderr: '',
      timedOut: false,
      aborted: false,
    };
  });
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const deps: AgentDeps = {
    db,
    config: TEST_CONFIG,
    engine,
    github,
    linear,
    repoMap: () => TEST_REPO_MAP,
    codeArtifact,
    host,
    secrets: { claudeToken: 'claude-token', ghToken: 'gh-token' },
    skillDirs: { github: '/skills/github', meetingpackage: '/skills/meetingpackage' },
    imageContextDir: '/ctx',
    runsDir,
    promptsDir: path.join(process.cwd(), 'prompts'),
    now: () => 1_000,
  };
  return { deps, engine, github, linear, host, awsCalls, runsDir };
}
