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

recordPollSuccess(db, 'slack', 'initialized', now - 30_000);
recordPollSuccess(db, 'config', null, now - 30_000);
recordPollError(db, 'linear', 'Linear server error 502', now - 20_000);
console.log(`Seeded demo data into ${defaultDbPath()}`);
