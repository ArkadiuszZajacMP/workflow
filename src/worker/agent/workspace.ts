import type { Item, Workspace } from '@/core/db/schema';
import { errorMessage, PermanentError } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { findRepo, type RepoEntry } from '@/core/repos/map';
import { createWorkspaceRow, getWorkspace, updateWorkspace, workspaceName } from '@/core/work/workspaces';
import { withRegistryAuth } from './codeartifact';
import type { AgentDeps, AgentHandler } from './deps';

export const CONTAINER_HOME = '/home/node';
const CLONE_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;

/** Token for the repo's private npm registry, or null when the repo needs none. */
export async function registryAuth(deps: AgentDeps, repo: RepoEntry): Promise<{ registry: string; token: string } | null> {
  const defaults = deps.repoMap().defaults;
  if (repo.awsProfile) {
    return { registry: defaults.codeArtifactRegistry, token: await deps.codeArtifact.token(repo.awsProfile, defaults) };
  }
  if (repo.type !== 'node' || !defaults.awsProfile) return null;
  try {
    return { registry: defaults.codeArtifactRegistry, token: await deps.codeArtifact.token(defaults.awsProfile, defaults) };
  } catch (err) {
    console.warn(`[agent] No CodeArtifact token for ${repo.key} (default profile): ${errorMessage(err)}`);
    return null;
  }
}

async function setupHome(deps: AgentDeps, container: string): Promise<void> {
  const mkdir = await deps.engine.exec({ container, args: ['mkdir', '-p', `${CONTAINER_HOME}/.claude/skills`] });
  if (mkdir.exitCode !== 0) throw new PermanentError(`Could not prepare ${container}: ${mkdir.stderr.trim()}`);
  await deps.engine.copyInto(container, deps.skillDirs.github, `${CONTAINER_HOME}/.claude/skills/github`);
  await deps.engine.copyInto(container, deps.skillDirs.meetingpackage, `${CONTAINER_HOME}/.claude/skills/meetingpackage`);
  const identity = await deps.host.gitIdentity();
  const settings: [string, string][] = [
    ['user.name', identity.name],
    ['user.email', identity.email],
    ['credential.helper', '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'],
  ];
  for (const [key, value] of settings) {
    const result = await deps.engine.exec({ container, args: ['git', 'config', '--global', key, value] });
    if (result.exitCode !== 0) throw new PermanentError(`git config ${key} failed in ${container}: ${result.stderr.trim()}`);
  }
}

async function prepareRepo(deps: AgentDeps, container: string, repo: RepoEntry): Promise<void> {
  const dir = `/work/${repo.key}`;
  const exists = await deps.engine.exec({ container, args: ['test', '-d', `${dir}/.git`] });
  if (exists.exitCode !== 0) {
    const clone = await deps.engine.exec({
      container,
      env: { GH_TOKEN: deps.secrets.ghToken },
      args: ['git', 'clone', repo.url, dir],
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (clone.exitCode !== 0) throw new PermanentError(`git clone ${repo.repo} failed: ${clone.stderr.trim().slice(-500)}`);
  }
  if (repo.node) {
    const tools = await deps.engine.exec({
      container,
      workdir: dir,
      args: [
        'sh',
        '-c',
        'printf "node %s\\n" "$1" > .tool-versions && (grep -qx .tool-versions .git/info/exclude || echo .tool-versions >> .git/info/exclude) && mise install',
        'sh',
        repo.node,
      ],
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (tools.exitCode !== 0) throw new PermanentError(`mise install failed in ${repo.key}: ${tools.stderr.trim().slice(-500)}`);
  }
  if (repo.installCommand) {
    const auth = await registryAuth(deps, repo);
    const base = ['sh', '-c', repo.installCommand];
    const install = await deps.engine.exec({
      container,
      workdir: dir,
      env: auth ? { CODEARTIFACT_AUTH_TOKEN: auth.token } : undefined,
      args: auth ? withRegistryAuth(base, auth.registry) : base,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.exitCode !== 0) {
      throw new PermanentError(`${repo.installCommand} failed in ${repo.key}: ${(install.stderr || install.stdout).trim().slice(-800)}`);
    }
  }
  if (deps.config.agent.syncEnv && repo.envTargets.length > 0) {
    const envDir = await deps.host.syncEnv(repo.key, deps.config.agent.envName);
    if (envDir) await deps.engine.copyInto(container, `${envDir}/.`, `${dir}/`);
  }
}

/** Makes sure the item's container exists, is running, and has `repoKeys` cloned and installed. Idempotent. */
export async function ensureWorkspace(deps: AgentDeps, item: Item, repoKeys: string[]): Promise<Workspace> {
  if (!item.linearIdentifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const map = deps.repoMap();
  const repos = repoKeys.map((key) => {
    const repo = findRepo(map, key);
    if (!repo) throw new PermanentError(`Unknown repository "${key}"`);
    return repo;
  });
  const name = workspaceName(item.linearIdentifier);
  const image = deps.config.agent.image;
  let ws = getWorkspace(deps.db, item.id);
  if (!ws || ws.status === 'removed') ws = createWorkspaceRow(deps.db, { itemId: item.id, container: name, volume: name, image }, deps.now());
  try {
    if (!(await deps.engine.imageExists(image))) await deps.engine.buildImage(image, deps.imageContextDir);
    const { created } = await deps.engine.ensureContainer(name, image);
    if (created || ws.status !== 'ready') await setupHome(deps, name);
    const prepared = new Set(created ? [] : ws.repos);
    for (const repo of repos) {
      if (prepared.has(repo.key)) continue;
      await prepareRepo(deps, name, repo);
      prepared.add(repo.key);
      updateWorkspace(deps.db, item.id, { repos: [...prepared] }, deps.now());
    }
    return updateWorkspace(deps.db, item.id, { status: 'ready', repos: [...prepared] }, deps.now())!;
  } catch (err) {
    updateWorkspace(deps.db, item.id, { status: 'broken' }, deps.now());
    throw err;
  }
}

export const removeWorkspaceHandler: AgentHandler = async (deps, job) => {
  const item = getItem(deps.db, job.itemId);
  const ws = getWorkspace(deps.db, job.itemId);
  if (!item || !ws || ws.status === 'removed') return;
  await deps.engine.remove(ws.container);
  updateWorkspace(deps.db, job.itemId, { status: 'removed', repos: [] }, deps.now());
  logActivity(deps.db, job.itemId, `Workspace ${ws.container} removed`, deps.now());
};
