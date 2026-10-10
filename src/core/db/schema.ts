import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ThreadMessage } from '../types';

export const CATEGORIES = ['triage', 'in_progress', 'verification', 'done', 'dismissed'] as const;
export type Category = (typeof CATEGORIES)[number];

export const TRIAGE_STATES = [
  'new',
  'checking_duplicates',
  'duplicate_suspected',
  'drafting',
  'draft_ready',
  'creating_issue',
  'linked',
  'failed',
] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

export const JOB_TYPES = ['triage-draft', 'draft', 'create-linear-issue', 'link-linear-issue'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const items = sqliteTable(
  'items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    category: text('category', { enum: CATEGORIES }).notNull(),
    triageState: text('triage_state', { enum: TRIAGE_STATES }),
    failedFromState: text('failed_from_state', { enum: TRIAGE_STATES }),
    title: text('title').notNull().default(''),
    slackChannel: text('slack_channel'),
    slackThreadTs: text('slack_thread_ts'),
    slackPermalink: text('slack_permalink'),
    slackThread: text('slack_thread', { mode: 'json' }).$type<ThreadMessage[]>(),
    linearIssueId: text('linear_issue_id'),
    linearIdentifier: text('linear_identifier'),
    linearUrl: text('linear_url'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('items_slack_thread_idx').on(t.slackChannel, t.slackThreadTs),
    uniqueIndex('items_linear_issue_idx').on(t.linearIssueId),
    index('items_category_idx').on(t.category),
  ],
);

export const sourceEvents = sqliteTable('source_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: integer('item_id').references(() => items.id),
  source: text('source', { enum: ['slack', 'linear'] }).notNull(),
  kind: text('kind').notNull(),
  externalKey: text('external_key').notNull().unique(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  seenAt: integer('seen_at').notNull(),
});

export const drafts = sqliteTable(
  'drafts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    problem: text('problem').notNull(),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull(),
    author: text('author', { enum: ['claude', 'user'] }).notNull(),
    feedback: text('feedback'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('drafts_item_version_idx').on(t.itemId, t.version)],
);

export const duplicateCandidates = sqliteTable('duplicate_candidates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: integer('item_id')
    .notNull()
    .references(() => items.id),
  linearIssueId: text('linear_issue_id').notNull(),
  linearIdentifier: text('linear_identifier').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  confidence: real('confidence').notNull(),
  reasoning: text('reasoning').notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type', { enum: JOB_TYPES }).notNull(),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    runAfter: integer('run_after').notNull(),
    startedAt: integer('started_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('jobs_status_run_after_idx').on(t.status, t.runAfter)],
);

export const pollCursors = sqliteTable('poll_cursors', {
  source: text('source').primaryKey(),
  cursor: text('cursor'),
  lastSuccessAt: integer('last_success_at'),
  lastError: text('last_error'),
  lastErrorAt: integer('last_error_at'),
});

export const linearIssueSnapshots = sqliteTable('linear_issue_snapshots', {
  issueId: text('issue_id').primaryKey(),
  statusName: text('status_name').notNull(),
  labelNames: text('label_names', { mode: 'json' }).$type<string[]>().notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const activity = sqliteTable('activity', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemId: integer('item_id')
    .notNull()
    .references(() => items.id),
  message: text('message').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Draft = typeof drafts.$inferSelect;
export type DuplicateCandidate = typeof duplicateCandidates.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type PollCursor = typeof pollCursors.$inferSelect;
export type LinearIssueSnapshot = typeof linearIssueSnapshots.$inferSelect;
