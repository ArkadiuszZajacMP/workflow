import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { PermanentError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { getWorkspace } from '@/core/work/workspaces';
import { makeAgentDeps } from '@/test/agent';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { ensureWorkspace, registryAuth, removeWorkspaceHandler } from './workspace';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});
const item = () => seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1430' });
const cmd = (args: string[]) => args.join(' ');

describe('ensureWorkspace', () => {
  it('builds the image, creates the container, sets up home and prepares each repo once', async () => {
    const { deps, engine, host } = makeAgentDeps(db);
    host.envDirs.set('core', '/skills/docker/private/env/core/development');
    const it1 = item();

    const ws = await ensureWorkspace(deps, it1, ['core', 'web']);
    expect(ws).toMatchObject({ container: 'wf-boo-1430', status: 'ready', repos: ['core', 'web'] });
    expect(engine.built).toEqual(['workflow-agent:latest']);
    expect(engine.copies).toEqual([
      { container: 'wf-boo-1430', hostPath: '/skills/github', containerPath: '/home/node/.claude/skills/github' },
      { container: 'wf-boo-1430', hostPath: '/skills/meetingpackage', containerPath: '/home/node/.claude/skills/meetingpackage' },
      { container: 'wf-boo-1430', hostPath: '/skills/docker/private/env/core/development/.', containerPath: '/work/core/' },
    ]);
    const commands = engine.execs.map((e) => cmd(e.args));
    expect(commands).toContain('git config --global user.name Arek Z');
    expect(commands).toContain('git clone https://github.com/acme/core.git /work/core');
    const clone = engine.execs.find((e) => e.args[1] === 'clone')!;
    expect(clone.env).toEqual({ GH_TOKEN: 'gh-token' });
    const install = engine.execs.find((e) => e.workdir === '/work/core' && e.args.includes('yarn install'))!;
    expect(install.env).toEqual({ CODEARTIFACT_AUTH_TOKEN: 'ca-token' });
    expect(install.args[0]).toBe('sh');

    engine.execs = [];
    await ensureWorkspace(deps, getItem(db, it1.id)!, ['core']);
    expect(engine.execs.some((e) => e.args[1] === 'clone')).toBe(false);
  });

  it('scopes the git credential helper to GitHub', async () => {
    const { deps, engine } = makeAgentDeps(db);
    await ensureWorkspace(deps, item(), ['infra']);
    const helper = engine.execs.find((e) => e.args.join(' ').includes('helper'))!;
    expect(helper.args.slice(0, 4)).toEqual(['git', 'config', '--global', 'credential.https://github.com.helper']);
    expect(engine.execs.some((e) => e.args.includes('credential.helper'))).toBe(false);
  });

  it('pins node with an excluded .tool-versions only when the repo does not track one', async () => {
    const { deps, engine } = makeAgentDeps(db);
    await ensureWorkspace(deps, item(), ['web']);
    const commands = engine.execs.filter((e) => e.workdir === '/work/web' || e.args[2] === '/work/web').map((e) => e.args);
    expect(commands).toContainEqual(['git', '-C', '/work/web', 'ls-files', '--error-unmatch', '.tool-versions']);
    const tools = engine.execs.find((e) => e.workdir === '/work/web' && e.args.join(' ').includes('mise install'))!;
    expect(tools.args[0]).toBe('sh');
    expect(tools.args[2]).toContain('> .tool-versions');
    expect(tools.args[2]).toContain('.git/info/exclude');

    const db2 = createTestDb();
    const second = makeAgentDeps(db2);
    second.engine.trackedFiles.add('/work/web/.tool-versions');
    await ensureWorkspace(second.deps, seedItem(db2, { linearIssueId: 'i2', linearIdentifier: 'BOO-2' }), ['web']);
    const tracked = second.engine.execs.filter((e) => e.workdir === '/work/web' && e.args.join(' ').includes('mise install'));
    expect(tracked.map((e) => e.args)).toEqual([['mise', 'install']]);
    expect(second.engine.execs.some((e) => e.args.join(' ').includes('> .tool-versions'))).toBe(false);
  });

  it('re-clones a repo whose directory has no checked-out HEAD, and keeps a good clone', async () => {
    const { deps, engine } = makeAgentDeps(db);
    const it1 = item();
    engine.on((r) => r.args[3] === 'rev-parse' && r.args[2] === '/work/infra', { exitCode: 128 }, true);
    await ensureWorkspace(deps, it1, ['infra']);
    const commands = engine.execs.map((e) => cmd(e.args));
    const rm = commands.indexOf('rm -rf /work/infra');
    expect(rm).toBeGreaterThan(-1);
    expect(commands.indexOf('git clone https://github.com/acme/infra.git /work/infra')).toBeGreaterThan(rm);

    // A recreated container re-prepares its repos; the existing clone is kept.
    engine.execs = [];
    engine.containers.clear();
    await ensureWorkspace(deps, getItem(db, it1.id)!, ['infra']);
    const again = engine.execs.map((e) => cmd(e.args));
    expect(again).toContain('git -C /work/infra rev-parse --verify --quiet HEAD');
    expect(again.some((c) => c.startsWith('rm -rf') || c.startsWith('git clone'))).toBe(false);
  });

  it('marks the workspace broken when preparing a repo fails', async () => {
    const { deps, engine } = makeAgentDeps(db);
    engine.on((r) => r.args.includes('npm install'), { exitCode: 1, stderr: 'ERESOLVE' });
    const it1 = item();
    const err = await ensureWorkspace(deps, it1, ['web']).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('npm install failed in web');
    expect(getWorkspace(db, it1.id)?.status).toBe('broken');
  });

  it('fails permanently for unknown repos', async () => {
    const { deps } = makeAgentDeps(db);
    await expect(ensureWorkspace(deps, item(), ['mobile'])).rejects.toThrow('Unknown repository "mobile"');
  });
});

describe('registryAuth', () => {
  it('uses the repo profile, else the default profile for node repos, and nothing for others', async () => {
    const { deps, awsCalls } = makeAgentDeps(db);
    const repo = (key: string) => TEST_REPO_MAP.repos.find((r) => r.key === key)!;
    await expect(registryAuth(deps, repo('core'))).resolves.toEqual({ registry: TEST_REPO_MAP.defaults.codeArtifactRegistry, token: 'ca-token' });
    expect(awsCalls[0]).toContain('core-artifactory');
    await expect(registryAuth(deps, repo('web'))).resolves.toMatchObject({ token: 'ca-token' });
    expect(awsCalls[1]).toContain('Acme-Artifactory');
    await expect(registryAuth(deps, repo('infra'))).resolves.toBeNull();
  });
});

describe('removeWorkspaceHandler', () => {
  it('removes the container and volume and records it', async () => {
    const { deps, engine } = makeAgentDeps(db);
    const it1 = item();
    await ensureWorkspace(deps, it1, ['infra']);
    const job = enqueueJob(db, 'remove-workspace', it1.id, {}, 1);
    await removeWorkspaceHandler(deps, claimNextJob(db, 1)!);
    expect(engine.removed).toEqual(['wf-boo-1430']);
    expect(getWorkspace(db, it1.id)?.status).toBe('removed');
    expect(listActivity(db, it1.id).at(-1)?.message).toBe('Workspace wf-boo-1430 removed');
    expect(job.id).toBeGreaterThan(0);
  });
});
