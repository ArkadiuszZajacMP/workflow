import path from 'node:path';
import { createClaudeClient, sdkComplete } from '@/core/clients/claude';
import { createGitHubClient } from '@/core/clients/github';
import { createLinearClient } from '@/core/clients/linear';
import { createSlackClient } from '@/core/clients/slack';
import { ConfigStore, configPath } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { defaultDbPath, openDb } from '@/core/db/client';
import { recoverRunningJobs } from '@/core/jobs/queue';
import { expandHome } from '@/core/paths';
import { loadRepoMap, type RepoMap } from '@/core/repos/map';
import { CodeArtifactTokens } from './agent/codeartifact';
import type { AgentDeps } from './agent/deps';
import { PodmanEngine } from './agent/engine';
import { cleanupStaleAgentRuns } from './agent/recovery';
import { createHostTools } from './agent/host';
import { AgentLane } from './agent/lane';
import { runProcess } from './agent/process';
import { pollOnce, runNextJob } from './runner';

const IDLE_MS = 2_000;
const SHUTDOWN_GRACE_MS = 15_000;
const FORCE_EXIT_AFTER_MS = 2_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[worker] Missing ${name}. Start the worker with npm run dev or npm run start:worker (they load secrets from 1Password via scripts/with-secrets.sh) and check the references in .env.op.`,
    );
    process.exit(1);
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const db = openDb(defaultDbPath());
  const configStore = new ConfigStore(configPath());
  const startupEngine = new PodmanEngine(configStore.reload().config?.agent.containerEngine ?? 'podman');
  const agentEnabled = Boolean(process.env.GITHUB_TOKEN && process.env.GH_TOKEN && process.env.CLAUDE_CODE_OAUTH_TOKEN);
  try {
    const cleaned = await cleanupStaleAgentRuns(db, agentEnabled ? startupEngine : null);
    if (cleaned.stopped > 0) console.log(`[worker] Marked ${cleaned.stopped} leftover agent run(s) as stopped`);
  } catch (err) {
    console.error(`[worker] Startup agent cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recovered = recoverRunningJobs(db);
  if (recovered.requeued > 0) console.log(`[worker] Requeued ${recovered.requeued} job(s) left running by a previous crash`);
  if (recovered.failed > 0) console.log(`[worker] Failed ${recovered.failed} crashed job(s) that were out of attempts`);

  const slack = createSlackClient(requireEnv('SLACK_USER_TOKEN'));
  const linear = createLinearClient(requireEnv('LINEAR_API_KEY'));
  let config: Config | null = null;
  const claude = createClaudeClient({ complete: sdkComplete(() => config?.claude.model ?? null) });

  const githubToken = process.env.GITHUB_TOKEN;
  const ghToken = process.env.GH_TOKEN;
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const github = agentEnabled ? createGitHubClient(githubToken!) : null;
  if (!agentEnabled) console.log('[worker] Agent workers disabled: GITHUB_TOKEN, GH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN is missing');

  const codeArtifact = new CodeArtifactTokens(runProcess);
  let cachedMap = null as { dir: string; map: RepoMap } | null;
  const repoMap = (): RepoMap => {
    const dir = expandHome(config!.agent.meetingpackageSkillDir);
    if (!cachedMap || cachedMap.dir !== dir) cachedMap = { dir, map: loadRepoMap(dir) };
    return cachedMap.map;
  };
  const agentDeps = (): AgentDeps | null => {
    if (!agentEnabled || !config || !github) return null;
    return {
      db,
      config,
      engine: new PodmanEngine(config.agent.containerEngine),
      github,
      linear,
      repoMap,
      codeArtifact,
      host: createHostTools({
        run: runProcess,
        dockerSkillDir: expandHome(config.agent.dockerSkillDir),
        meetingpackageSkillDir: expandHome(config.agent.meetingpackageSkillDir),
      }),
      secrets: { claudeToken: claudeToken!, ghToken: ghToken! },
      skillDirs: { github: expandHome(config.agent.githubSkillDir), meetingpackage: expandHome(config.agent.meetingpackageSkillDir) },
      imageContextDir: path.join(process.cwd(), 'containers', 'agent'),
      runsDir: path.join(path.dirname(defaultDbPath()), 'runs'),
      promptsDir: path.join(process.cwd(), 'prompts'),
      now: () => Date.now(),
    };
  };
  const lane = new AgentLane(agentDeps);

  let stopping = false;
  let stoppingAt = 0;
  let laneStopped: Promise<{ timedOut: boolean }> | null = null;
  // SIGHUP too: run processes are detached, so closing the terminal no longer reaches them directly.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (stopping) {
        // `node --watch` and npm relay the terminal's Ctrl-C, so one keypress arrives as two signals at once.
        // Only a later, deliberate second Ctrl-C forces the exit.
        if (Date.now() - stoppingAt < FORCE_EXIT_AFTER_MS) return;
        // Give up waiting. Detached run processes are killed on exit; recovery requeues their jobs.
        console.log('[worker] Forced exit');
        process.exit(1);
      }
      stopping = true;
      stoppingAt = Date.now();
      // Abort agent runs now rather than after the current core job returns; the grace period starts here.
      console.log(`[worker] stopping (${lane.size} agent run(s) in flight, waiting up to ${SHUTDOWN_GRACE_MS / 1000}s)`);
      laneStopped = lane.shutdown(SHUTDOWN_GRACE_MS);
    });
  }

  let nextPollAt = 0;
  console.log('[worker] started');
  while (!stopping) {
    if (Date.now() >= nextPollAt) {
      config = (await pollOnce({ db, slack, linear, configStore, github })) ?? config;
      nextPollAt = Date.now() + (config?.slack.pollIntervalSeconds ?? 60) * 1000;
    }
    if (config) {
      cachedMap = cachedMap && cachedMap.dir === expandHome(config.agent.meetingpackageSkillDir) ? cachedMap : null;
      lane.fill();
      const ctx = { db, config, slack, linear, claude, now: () => Date.now(), repoMap };
      while (!stopping && Date.now() < nextPollAt && (await runNextJob(ctx))) {
        lane.fill();
      }
    }
    await sleep(IDLE_MS);
  }
  const { timedOut } = await (laneStopped ?? lane.shutdown(SHUTDOWN_GRACE_MS));
  if (timedOut) console.log('[worker] Some agent runs did not stop in time; crash recovery handles them on the next start');
  process.exit(0);
}

main().catch((err) => {
  console.error('[worker] crashed', err);
  process.exit(1);
});
