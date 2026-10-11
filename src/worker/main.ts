import { createClaudeClient, sdkComplete } from '@/core/clients/claude';
import { createLinearClient } from '@/core/clients/linear';
import { createSlackClient } from '@/core/clients/slack';
import { ConfigStore, configPath } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { defaultDbPath, openDb } from '@/core/db/client';
import { recoverRunningJobs } from '@/core/jobs/queue';
import { pollOnce, runNextJob } from './runner';

const IDLE_MS = 2_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[worker] Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const db = openDb(defaultDbPath());
  const recovered = recoverRunningJobs(db);
  if (recovered.requeued > 0) console.log(`[worker] Requeued ${recovered.requeued} job(s) left running by a previous crash`);
  if (recovered.failed > 0) console.log(`[worker] Failed ${recovered.failed} crashed job(s) that were out of attempts`);

  const slack = createSlackClient(requireEnv('SLACK_USER_TOKEN'));
  const linear = createLinearClient(requireEnv('LINEAR_API_KEY'));
  const configStore = new ConfigStore(configPath());
  let config: Config | null = null;
  const claude = createClaudeClient({ complete: sdkComplete(() => config?.claude.model ?? null) });

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  let nextPollAt = 0;
  console.log('[worker] started');
  while (!stopping) {
    if (Date.now() >= nextPollAt) {
      config = (await pollOnce({ db, slack, linear, configStore })) ?? config;
      nextPollAt = Date.now() + (config?.slack.pollIntervalSeconds ?? 60) * 1000;
    }
    if (config) {
      const ctx = { db, config, slack, linear, claude, now: () => Date.now() };
      while (!stopping && Date.now() < nextPollAt && (await runNextJob(ctx))) {
        // keep draining due jobs until the next poll is due
      }
    }
    await sleep(IDLE_MS);
  }
  console.log('[worker] stopped');
}

main().catch((err) => {
  console.error('[worker] crashed', err);
  process.exit(1);
});
