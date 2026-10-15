import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { enqueueJob, claimNextJob } from '@/core/jobs/queue';
import { createPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { startRun } from '@/core/work/runs';
import { createWorkspaceRow, updateWorkspace } from '@/core/work/workspaces';
import type { RepoMap } from '@/core/repos/map';
import { eq } from 'drizzle-orm';
import { recordPollError, recordPollSuccess } from '@/core/cursors';
import { defaultDbPath, openDb } from '@/core/db/client';
import { items, jobs } from '@/core/db/schema';
import { replaceDuplicateCandidates, saveDraft } from '@/core/drafts';
import { logActivity, upsertLinearItem } from '@/core/items';

const db = openDb(defaultDbPath());
if (db.select().from(items).all().length > 0) {
  console.error(`Refusing to seed ${defaultDbPath()}: it already has items. Point WORKFLOW_DB at a fresh file.`);
  process.exit(1);
}
const now = Date.now();
const thread = (text: string) => [
  { ts: '1.0', userName: 'ana', text, files: [] },
  { ts: '1.1', userName: 'bo', text: 'Seeing this too since this morning.', files: ['screenshot.png'] },
];
const insert = (values: Partial<typeof items.$inferInsert>) =>
  db.insert(items).values({ category: 'triage', createdAt: now - 3_600_000, updatedAt: now, ...values }).returning().get();

const draftReady = insert({
  title: 'CSV export returns 500 for large workspaces',
  triageState: 'draft_ready',
  slackChannel: 'C_DEMO',
  slackThreadTs: '1.0',
  slackPermalink: 'https://slack.com/archives/C_DEMO/p10',
  slackThread: thread('CSV export returns 500 for large workspaces'),
});
saveDraft(db, draftReady.id, {
  title: 'CSV export returns 500 for large workspaces',
  problem: 'Exporting bookings to CSV fails with HTTP 500 for workspaces with more than ~10k bookings.',
  acceptanceCriteria: ['Export completes for a workspace with 50k bookings', 'Users see a clear error if an export fails'],
}, 'claude', null, now);
logActivity(db, draftReady.id, ':eyes: added in Slack', now - 3_600_000);
logActivity(db, draftReady.id, 'Draft v1 by Claude', now - 3_000_000);

const duplicate = insert({
  title: 'Calendar sync shows events twice',
  triageState: 'duplicate_suspected',
  slackChannel: 'C_DEMO',
  slackThreadTs: '2.0',
  slackPermalink: 'https://slack.com/archives/C_DEMO/p20',
  slackThread: thread('Calendar sync shows events twice'),
});
replaceDuplicateCandidates(db, duplicate.id, [
  { issue: { id: 'demo-1', identifier: 'ENG-41', title: 'Duplicate events after Google sync', url: 'https://linear.app' }, confidence: 0.88, reasoning: 'Both describe events appearing twice after calendar sync.' },
]);

const failed = insert({
  title: 'Invoice PDF missing VAT number',
  triageState: 'failed',
  failedFromState: 'new',
  lastError: 'Slack API error: channel_not_found',
  slackChannel: 'C_DEMO',
  slackThreadTs: '3.0',
});
// A failed item always has a failed job behind it; Retry requeues that job.
db.insert(jobs)
  .values({
    type: 'triage-draft',
    itemId: failed.id,
    payload: {},
    status: 'failed',
    attempts: 3,
    runAfter: now,
    lastError: 'Slack API error: channel_not_found',
    createdAt: now - 3_000_000,
    updatedAt: now,
  })
  .run();
upsertLinearItem(db, { id: 'demo-2', identifier: 'ENG-52', title: 'Room capacity filter ignores accessibility', url: 'https://linear.app' }, 'in_progress', now);
upsertLinearItem(db, { id: 'demo-3', identifier: 'ENG-60', title: 'Search times out on long queries', url: 'https://linear.app' }, 'done', now);

const demoMap: RepoMap = {
  defaults: { awsRegion: 'eu-west-2', awsAccountId: '0', codeArtifactDomain: 'd', codeArtifactRegistry: 'https://example.com/npm/x/' },
  repos: [
    { key: 'mp-core', repo: 'cocouz/mp-core', url: '', defaultBranch: 'main', type: 'node', installCommand: '', validationCommands: [], envTargets: [], aliases: [] },
    { key: 'mp_dashboard', repo: 'cocouz/mp_dashboard', url: '', defaultBranch: 'main', type: 'node', installCommand: '', validationCommands: [], envTargets: [], aliases: [] },
  ],
};

const planReady = upsertLinearItem(db, { id: 'demo-10', identifier: 'BOO-1430', title: 'core-api drops every JSON request body', url: 'https://linear.app' }, 'triage', now);
db.update(items).set({ workState: 'plan_ready' }).where(eq(items.id, planReady.id)).run();
savePlan(db, planReady.id, {
  body: '## Findings\nThe webhook raw-body parser is registered globally and disables Nest\'s JSON parser.\n## Approach\nScope the raw parser to /webhooks routes.\n## Risks\nWebhook signature checks must keep the raw body.',
  breakdown: [
    { repo: 'mp-core', scope: 'Scope the raw-body parser to webhook routes and add a regression test' },
    { repo: 'mp_dashboard', scope: 'Show a clear error when a save request fails' },
  ],
}, 'claude', null, now);

const implementing = upsertLinearItem(db, { id: 'demo-11', identifier: 'BOO-1503', title: 'BEv2: date picker closes before rates load', url: 'https://linear.app' }, 'in_progress', now);
db.update(items).set({ workState: 'implementing' }).where(eq(items.id, implementing.id)).run();
const implPlan = savePlan(db, implementing.id, { body: 'Keep the picker open while rates load.', breakdown: [
  { repo: 'mp-core', scope: 'Return rates loading state' },
  { repo: 'mp_dashboard', scope: 'Keep the date picker open while rates load' },
] }, 'claude', null, now);
const [p1, p2] = createPlannedPrs(db, implementing, implPlan, demoMap, now);
updatePlannedPr(db, p1!.id, { state: 'open', prNumber: 4821, prUrl: 'https://github.com/cocouz/mp-core/pull/4821', isDraft: true, ciState: 'failure', unresolvedThreads: 2 }, now);
updatePlannedPr(db, p2!.id, { state: 'implementing' }, now);
createWorkspaceRow(db, { itemId: implementing.id, container: 'wf-boo-1503', volume: 'wf-boo-1503', image: 'workflow-agent:latest' }, now);
updateWorkspace(db, implementing.id, { status: 'ready', repos: ['mp-core', 'mp_dashboard'] }, now);
enqueueJob(db, 'implement-pr', implementing.id, { plannedPrId: p2!.id }, now);
const runningJob = claimNextJob(db, now, ['implement-pr'])!;
const runsDir = path.join(path.dirname(defaultDbPath()), 'runs');
mkdirSync(runsDir, { recursive: true });
const logPath = path.join(runsDir, `demo-${runningJob.id}.jsonl`);
writeFileSync(
  logPath,
  [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'demo' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading DatePicker.tsx' }, { type: 'tool_use', name: 'Read', input: { file_path: '/work/mp_dashboard/src/DatePicker.tsx' } }] } }),
  ].join('\n') + '\n',
);
startRun(db, { jobId: runningJob.id, itemId: implementing.id, plannedPrId: p2!.id, kind: 'implement-pr', logPath }, now);

recordPollSuccess(db, 'slack', 'initialized', now - 30_000);
recordPollSuccess(db, 'config', null, now - 30_000);
recordPollError(db, 'linear', 'Linear server error 502', now - 20_000);
console.log(`Seeded demo data into ${defaultDbPath()}`);
