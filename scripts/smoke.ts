import { extractJson, sdkComplete } from '@/core/clients/claude';
import { createGitHubClient } from '@/core/clients/github';
import { createLinearClient } from '@/core/clients/linear';
import { createSlackClient } from '@/core/clients/slack';
import { errorMessage } from '@/core/errors';
import { runProcess } from '@/worker/agent/process';

async function check(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`✓ ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    console.log(`✗ ${name}: ${errorMessage(err)}`);
    return false;
  }
}

const results = [
  await check('Slack', async () => {
    const res = await createSlackClient(process.env.SLACK_USER_TOKEN ?? '').authTest();
    return `user ${res.userId} in ${res.team}`;
  }),
  await check('Linear', async () => {
    const viewer = await createLinearClient(process.env.LINEAR_API_KEY ?? '').viewer();
    return `viewer ${viewer.name}`;
  }),
  await check('Claude', async () => {
    const reply = await sdkComplete(() => null)('Reply with only this JSON: {"ok": true}');
    return JSON.stringify(extractJson(reply));
  }),
  await check('GitHub', async () => {
    if (!process.env.GITHUB_TOKEN) return 'skipped (GITHUB_TOKEN not set)';
    const viewer = await createGitHubClient(process.env.GITHUB_TOKEN).viewer();
    return `viewer ${viewer.login}`;
  }),
  await check('Podman', async () => {
    const info = await runProcess('podman', ['info', '--format', '{{.Version.Version}}']);
    if (info.exitCode !== 0) throw new Error(info.stderr.trim() || 'podman info failed');
    return `version ${info.stdout.trim()}`;
  }),
  await check('Claude in container', async () => {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) return 'skipped (CLAUDE_CODE_OAUTH_TOKEN not set)';
    const image = 'workflow-agent:latest';
    if ((await runProcess('podman', ['image', 'exists', image])).exitCode !== 0) return 'skipped (run npm run agent:build-image first)';
    const run = await runProcess(
      'podman',
      ['run', '--rm', '-i', '--env', 'CLAUDE_CODE_OAUTH_TOKEN', image, 'claude', '-p', '--max-turns', '1'],
      { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, stdin: 'Reply with only: ok', timeoutMs: 120_000 },
    );
    if (run.exitCode !== 0 || !/ok/i.test(run.stdout)) throw new Error((run.stderr || run.stdout).trim().slice(-300));
    return 'replied ok';
  }),
];
process.exit(results.every(Boolean) ? 0 : 1);
