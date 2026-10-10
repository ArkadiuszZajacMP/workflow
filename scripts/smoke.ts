import { extractJson, sdkComplete } from '@/core/clients/claude';
import { createLinearClient } from '@/core/clients/linear';
import { createSlackClient } from '@/core/clients/slack';
import { errorMessage } from '@/core/errors';

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
];
process.exit(results.every(Boolean) ? 0 : 1);
