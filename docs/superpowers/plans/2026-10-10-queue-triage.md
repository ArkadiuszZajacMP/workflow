# Queue Core, Ingestion and 👀 Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local queue that ingests Slack reactions and Linear status/label changes via config rules, and runs the 👀 flow (Claude duplicate check → in-app draft → approval → Linear issue), with a Next.js dashboard and a CLI.

**Architecture:** One repo, three entry points sharing a synchronous `src/core` library and one SQLite file: a Next.js web app (reads the queue, writes only through `core/actions`), a Node worker (the only process that calls Slack, Linear and Claude; it runs the pollers and a SQLite-backed jobs queue), and a commander CLI. Pure logic (rules, triage state machine, diffing, formatting) is separate from I/O so it can be unit-tested.

**Tech Stack:** Node 24, TypeScript, Next.js 16 (App Router), React 19, shadcn/ui + Tailwind CSS 4, better-sqlite3 + Drizzle ORM/drizzle-kit, zod 4, yaml, commander, @slack/web-api, Linear GraphQL over `fetch`, @anthropic-ai/claude-agent-sdk, Vitest, tsx, concurrently.

**Spec:** `docs/superpowers/specs/2026-10-10-queue-triage-design.md`

## Global Constraints

- Package manager is **npm** (pnpm is not installed on this machine). Spec commands map as follows: `pnpm dev` → `npm run dev`, `pnpm queue …` → `npm run queue -- …`, `pnpm smoke` → `npm run smoke`.
- Localhost only: the web server binds to `127.0.0.1`. No authentication.
- The web app and the CLI never call Slack, Linear or Claude. Only `src/worker/**` and `scripts/smoke.ts` construct real clients.
- Client components (`'use client'`) may only `import type` from `@/core/**`. Runtime imports from core would bundle better-sqlite3 into the browser.
- Secrets come only from `.env` (`SLACK_USER_TOKEN`, `LINEAR_API_KEY`). `.env` and `data/` are gitignored. `.env.example` is committed.
- DB file: `data/workflow.db` by default, overridable with `WORKFLOW_DB`. Config file: `workflow.config.yaml`, overridable with `WORKFLOW_CONFIG`.
- Timestamps in our tables are epoch milliseconds (`integer`). Linear `updatedAt` is kept as the ISO string Linear returns.
- The Linear issue description is exactly `## Problem\n<problem>\n\n## Acceptance criteria\n- [ ] <criterion>…`. Drafts contain only the problem and acceptance criteria.
- No live API calls in `npm test`. Slack, Linear and Claude are faked through the interfaces in `src/core/clients/types.ts`.
- Tests are colocated as `src/**/*.test.ts` and run with Vitest. The import alias `@/` maps to `src/`.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (passed as a second `-m`).

### Intentional differences from the spec

These are small and made for implementability. Mention them when you report back.

1. npm instead of pnpm (see above).
2. `items` gets two extra columns: `slack_thread` (JSON thread snapshot, so the web app can show a preview without calling Slack) and `failed_from_state` (what Retry restores).
3. `transition()` returns `{ ok, state }` only. Effects (enqueueing jobs, activity) are done by the callers in `core/actions` and the handlers.
4. Crash recovery resets **all** `running` jobs when the worker starts, not only those older than 15 minutes. There is a single worker, so any job still `running` at startup is orphaned.
5. On the first Linear poll (no cursor) only open issues (state type not `completed`/`canceled`) are fetched, so years of closed issues don't flood the queue.
6. Linear `status` and `label` rule matchers compare case-insensitively. Slack reaction names compare exactly.

## Review Focus

1. **A 👀 on a reply inside an already-queued thread** must reuse the thread's item and must not start a second triage run. Test: Task 6 (`ingestEvent` reuses the item, one job).
2. **Double-clicking Approve, Link or Revise** must enqueue one job, not two. Test: Task 7 (second `approve`/`link` throws `ActionError`, one job in table).
3. **Linking or creating an issue that the Linear poller already put in the queue as its own item** must merge into the Slack item instead of crashing on the unique index. Test: Task 6 (`claimLinearIssue`) and Task 14 (link handler).
4. **Linear issues whose `updatedAt` equals the stored cursor** must not be missed or double-counted. The poller uses `gte` and relies on snapshot diffing for dedupe. Test: Task 12.
5. **Dismissing an item while its job is queued or running** must stop the flow: no Claude calls, no Linear issue. Test: Task 13 and Task 14 (handlers no-op on dismissed items, including after the async calls return).

---

## File map

```
package.json, tsconfig.json, vitest.config.ts, drizzle.config.ts, next.config.ts, postcss.config.mjs
.env.example, workflow.config.yaml, .gitignore (modified), README.md (modified)
prompts/search-terms.md, prompts/assess-duplicates.md, prompts/draft.md
scripts/smoke.ts, scripts/seed-demo.ts
src/core/
  types.ts                 ThreadMessage, LinearIssueRef
  errors.ts                TransientError, PermanentError, ActionError, errorMessage
  events.ts                SourceEvent union + external key builders
  config/schema.ts, config/load.ts
  db/schema.ts, db/client.ts, db/migrations/ (generated)
  rules/match.ts
  triage/machine.ts, triage/schemas.ts, triage/format.ts
  jobs/queue.ts
  items.ts                 item repository, activity, triage events, claimLinearIssue, markItemFailed
  drafts.ts                drafts + duplicate candidates + issue description rendering
  cursors.ts               poll_cursors
  ingest.ts                event → source_events → rule → item/job
  queries.ts               read models for web + CLI
  actions/                 approve, discard, move, link, not-duplicate, revise, edit-draft, retry, guards, index
  clients/types.ts, clients/slack.ts, clients/linear.ts, clients/claude.ts
src/worker/
  pollers/slack.ts, pollers/linear.ts
  handlers/types.ts, handlers/triage-draft.ts, handlers/draft.ts,
  handlers/create-linear-issue.ts, handlers/link-linear-issue.ts
  runner.ts, main.ts
src/cli/program.ts, src/cli/main.ts
src/app/layout.tsx, src/app/page.tsx, src/app/globals.css, src/app/actions.ts
src/components/ (board, item-card, status-header, auto-refresh, item-sheet, thread-preview,
  duplicate-panel, draft-editor, activity-list, item-controls, use-action-runner) + ui/ (shadcn)
src/lib/format.ts, src/lib/board.ts, src/lib/item-actions.ts, src/lib/utils.ts (shadcn)
src/test/db.ts, src/test/seed.ts, src/test/fakes.ts
```

---

### Task 1: Project scaffold and config loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `workflow.config.yaml`
- Create: `src/core/config/schema.ts`, `src/core/config/load.ts`
- Modify: `.gitignore`
- Test: `src/core/config/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `configSchema` (zod), `type Config`, `type Rule`, `type RuleCategory = 'triage' | 'in_progress' | 'verification' | 'done'`, `RULE_CATEGORIES`
  - `parseConfig(text: string): ConfigResult`, `loadConfigFile(path: string): ConfigResult`, where `type ConfigResult = { ok: true; config: Config } | { ok: false; error: string }`
  - `class ConfigStore { constructor(path: string); reload(): { config: Config | null; error: string | null } }` — keeps the last valid config
  - `DEFAULT_CONFIG_PATH = 'workflow.config.yaml'`, `configPath(): string` (reads `WORKFLOW_CONFIG`)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "workflow",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n web,worker -c blue,magenta \"npm:dev:web\" \"npm:dev:worker\"",
    "dev:web": "next dev --hostname 127.0.0.1",
    "dev:worker": "node --watch --env-file-if-exists=.env --import tsx src/worker/main.ts",
    "build": "next build",
    "start:worker": "node --env-file-if-exists=.env --import tsx src/worker/main.ts",
    "queue": "node --env-file-if-exists=.env --import tsx src/cli/main.ts",
    "smoke": "node --env-file-if-exists=.env --import tsx scripts/smoke.ts",
    "seed:demo": "node --import tsx scripts/seed-demo.ts",
    "db:generate": "drizzle-kit generate",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Install the backend dependencies**

Run:
```bash
npm install drizzle-orm better-sqlite3 zod yaml commander @slack/web-api @anthropic-ai/claude-agent-sdk
npm install -D typescript @types/node @types/better-sqlite3 drizzle-kit vitest tsx concurrently
```
Expected: installs without errors. `node -e "require('better-sqlite3')(':memory:')"` prints nothing and exits 0.

- [ ] **Step 3: Create `tsconfig.json`, `vitest.config.ts`, `.env.example`, and extend `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowJs": false,
    "noEmit": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`vitest.config.ts`:
```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
```

`.env.example`:
```
# Slack user token (xoxp-…) with reactions:read, channels:history, groups:history, im:history, mpim:history, users:read
SLACK_USER_TOKEN=
# Linear personal API key
LINEAR_API_KEY=
# Optional overrides
# WORKFLOW_DB=data/workflow.db
# WORKFLOW_CONFIG=workflow.config.yaml
```

Append to `.gitignore`:
```
.env
data/
*.tsbuildinfo
next-env.d.ts
```

- [ ] **Step 4: Create `workflow.config.yaml`**

```yaml
linear:
  defaultTeam: ENG
slack:
  pollIntervalSeconds: 60
  backfillOnFirstRun: false
claude:
  model: null
triage:
  duplicateThreshold: 0.7
  searchClosedWithinDays: 90
  maxCandidates: 15
rules:
  - when: { source: slack, reaction: eyes }
    category: triage
    action: triage-draft
  - when: { source: slack, reaction: bookmark }
    category: triage
  - when: { source: linear, status: Triage }
    category: triage
  - when: { source: linear, label: needs-investigation }
    category: triage
```

- [ ] **Step 5: Write the failing test** — `src/core/config/load.test.ts`

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, parseConfig } from './load';

const minimal = 'linear:\n  defaultTeam: ENG\n';

describe('parseConfig', () => {
  it('applies defaults to a minimal config', () => {
    expect(parseConfig(minimal)).toEqual({
      ok: true,
      config: {
        linear: { defaultTeam: 'ENG' },
        slack: { pollIntervalSeconds: 60, backfillOnFirstRun: false },
        claude: { model: null },
        triage: { duplicateThreshold: 0.7, searchClosedWithinDays: 90, maxCandidates: 15 },
        rules: [],
      },
    });
  });

  it('parses the committed workflow.config.yaml', () => {
    const result = parseConfig(readFileSync('workflow.config.yaml', 'utf8'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.rules).toHaveLength(4);
  });

  it('rejects a rule with two matchers', () => {
    const text = `${minimal}rules:\n  - when: { source: slack, reaction: eyes, status: Triage }\n    category: triage\n`;
    expect(parseConfig(text).ok).toBe(false);
  });

  it('rejects triage-draft on a linear rule', () => {
    const text = `${minimal}rules:\n  - when: { source: linear, status: Triage }\n    category: triage\n    action: triage-draft\n`;
    expect(parseConfig(text)).toMatchObject({
      ok: false,
      error: expect.stringContaining('only allowed on slack rules'),
    });
  });

  it('rejects an unknown category', () => {
    const text = `${minimal}rules:\n  - when: { source: slack, reaction: eyes }\n    category: dismissed\n`;
    expect(parseConfig(text).ok).toBe(false);
  });

  it('rejects invalid YAML', () => {
    expect(parseConfig('linear: [')).toMatchObject({ ok: false, error: expect.stringContaining('Invalid YAML') });
  });

  it('rejects a config without a default team', () => {
    expect(parseConfig('slack: {}\n').ok).toBe(false);
  });
});

describe('ConfigStore', () => {
  it('keeps the last valid config when the file becomes invalid', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cfg-')), 'workflow.config.yaml');
    writeFileSync(file, minimal);
    const store = new ConfigStore(file);
    expect(store.reload()).toMatchObject({ error: null, config: { linear: { defaultTeam: 'ENG' } } });

    writeFileSync(file, 'linear: [');
    const second = store.reload();
    expect(second.config?.linear.defaultTeam).toBe('ENG');
    expect(second.error).toMatch(/Invalid YAML/);
  });

  it('reports a missing file with no previous config', () => {
    const store = new ConfigStore('/nonexistent/workflow.config.yaml');
    expect(store.reload()).toMatchObject({ config: null, error: expect.stringContaining('Cannot read') });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/core/config`
Expected: FAIL, `Cannot find module './load'` (or similar resolution error).

- [ ] **Step 7: Implement** `src/core/config/schema.ts`

```ts
import { z } from 'zod';

export const RULE_CATEGORIES = ['triage', 'in_progress', 'verification', 'done'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

const slackWhen = z.strictObject({ source: z.literal('slack'), reaction: z.string().min(1) });
const linearStatusWhen = z.strictObject({ source: z.literal('linear'), status: z.string().min(1) });
const linearLabelWhen = z.strictObject({ source: z.literal('linear'), label: z.string().min(1) });

export const ruleSchema = z
  .strictObject({
    when: z.union([slackWhen, linearStatusWhen, linearLabelWhen]),
    category: z.enum(RULE_CATEGORIES),
    action: z.literal('triage-draft').optional(),
  })
  .refine((rule) => rule.action === undefined || rule.when.source === 'slack', {
    message: 'action "triage-draft" is only allowed on slack rules',
  });

export const configSchema = z.strictObject({
  linear: z.strictObject({ defaultTeam: z.string().min(1) }),
  slack: z
    .strictObject({
      pollIntervalSeconds: z.number().int().min(10).default(60),
      backfillOnFirstRun: z.boolean().default(false),
    })
    .prefault({}),
  claude: z.strictObject({ model: z.string().min(1).nullable().default(null) }).prefault({}),
  triage: z
    .strictObject({
      duplicateThreshold: z.number().min(0).max(1).default(0.7),
      searchClosedWithinDays: z.number().int().min(0).default(90),
      maxCandidates: z.number().int().min(1).max(50).default(15),
    })
    .prefault({}),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
export type Rule = z.infer<typeof ruleSchema>;
```

- [ ] **Step 8: Implement** `src/core/config/load.ts`

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { type Config, configSchema } from './schema';

export const DEFAULT_CONFIG_PATH = 'workflow.config.yaml';

export function configPath(): string {
  return process.env.WORKFLOW_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

export function parseConfig(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${(err as Error).message}` };
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: `Invalid config: ${z.prettifyError(result.error)}` };
  return { ok: true, config: result.data };
}

export function loadConfigFile(path: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `Cannot read ${path}: ${(err as Error).message}` };
  }
  return parseConfig(text);
}

export class ConfigStore {
  private last: Config | null = null;

  constructor(private readonly path: string) {}

  reload(): { config: Config | null; error: string | null } {
    const result = loadConfigFile(this.path);
    if (result.ok) {
      this.last = result.config;
      return { config: result.config, error: null };
    }
    return { config: this.last, error: result.error };
  }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run src/core/config && npx tsc --noEmit`
Expected: all 9 tests PASS; tsc prints nothing.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example .gitignore workflow.config.yaml src/core/config
git commit -m "feat: scaffold project and add config loading" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database schema, client and test helpers

**Files:**
- Create: `drizzle.config.ts`, `src/core/types.ts`, `src/core/db/schema.ts`, `src/core/db/client.ts`, `src/core/db/migrations/*` (generated)
- Create: `src/test/db.ts`, `src/test/seed.ts`
- Test: `src/core/db/client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/core/types.ts`: `type ThreadMessage = { ts: string; userName: string; text: string; files: string[] }`, `type LinearIssueRef = { id: string; identifier: string; title: string; url: string }`
  - `schema.ts`: tables `items`, `sourceEvents`, `drafts`, `duplicateCandidates`, `jobs`, `pollCursors`, `linearIssueSnapshots`, `activity`; constants `CATEGORIES`, `TRIAGE_STATES`, `JOB_TYPES`, `JOB_STATUSES`; types `Category`, `TriageState`, `JobType`, `JobStatus`, `Item`, `NewItem`, `Draft`, `DuplicateCandidate`, `Job`, `Activity`, `PollCursor`, `LinearIssueSnapshot`
  - `client.ts`: `type Db`, `openDb(file: string): Db`, `defaultDbPath(): string`, `getDb(): Db`
  - `src/test/db.ts`: `createTestDb(): Db`
  - `src/test/seed.ts`: `seedItem(db: Db, overrides?: Partial<NewItem>): Item`

- [ ] **Step 1: Write `src/core/types.ts`**

```ts
export type ThreadMessage = { ts: string; userName: string; text: string; files: string[] };

export type LinearIssueRef = { id: string; identifier: string; title: string; url: string };
```

- [ ] **Step 2: Write `src/core/db/schema.ts`**

```ts
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
```

- [ ] **Step 3: Write `drizzle.config.ts` and generate the first migration**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/core/db/schema.ts',
  out: './src/core/db/migrations',
});
```

Run: `npm run db:generate -- --name init`
Expected: creates `src/core/db/migrations/0000_init.sql` and `src/core/db/migrations/meta/`. The SQL contains `CREATE TABLE \`items\`` and `CREATE UNIQUE INDEX \`items_slack_thread_idx\``.

- [ ] **Step 4: Write the failing test** — `src/core/db/client.test.ts`

```ts
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { items } from './schema';

describe('openDb', () => {
  it('creates all tables and enables WAL', () => {
    const db = createTestDb();
    const tables = db
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migrations%' ORDER BY name`,
      )
      .map((row) => row.name);
    expect(tables).toEqual([
      'activity',
      'drafts',
      'duplicate_candidates',
      'items',
      'jobs',
      'linear_issue_snapshots',
      'poll_cursors',
      'source_events',
    ]);
    expect(db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`)[0]?.journal_mode).toBe('wal');
  });

  it('allows one item per Slack thread but any number of items without a thread', () => {
    const db = createTestDb();
    seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' });
    expect(() => seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' })).toThrow(/UNIQUE/);
    seedItem(db);
    seedItem(db);
    expect(db.select().from(items).all()).toHaveLength(3);
  });

  it('round-trips JSON columns', () => {
    const db = createTestDb();
    const item = seedItem(db, { slackThread: [{ ts: '1.0', userName: 'ana', text: 'hi', files: [] }] });
    expect(item.slackThread).toEqual([{ ts: '1.0', userName: 'ana', text: 'hi', files: [] }]);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/core/db`
Expected: FAIL, cannot resolve `@/test/db`.

- [ ] **Step 6: Implement `src/core/db/client.ts`**

```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

export type Db = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

const MIGRATIONS_FOLDER = path.join(process.cwd(), 'src/core/db/migrations');

export function openDb(file: string): Db {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export function defaultDbPath(): string {
  return process.env.WORKFLOW_DB ?? path.join(process.cwd(), 'data', 'workflow.db');
}

const globalForDb = globalThis as unknown as { workflowDb?: Db };

/** Process-wide connection. Cached on globalThis so Next.js hot reloads reuse it. */
export function getDb(): Db {
  globalForDb.workflowDb ??= openDb(defaultDbPath());
  return globalForDb.workflowDb;
}
```

- [ ] **Step 7: Implement the test helpers**

`src/test/db.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Db, openDb } from '@/core/db/client';

export function createTestDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-test-'));
  return openDb(path.join(dir, 'test.db'));
}
```

`src/test/seed.ts`:
```ts
import type { Db } from '@/core/db/client';
import { type Item, items, type NewItem } from '@/core/db/schema';

export function seedItem(db: Db, overrides: Partial<NewItem> = {}): Item {
  return db
    .insert(items)
    .values({ category: 'triage', title: 'Seeded item', createdAt: 1_000, updatedAt: 1_000, ...overrides })
    .returning()
    .get();
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/core/db && npx tsc --noEmit`
Expected: 3 tests PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add drizzle.config.ts src/core/types.ts src/core/db src/test
git commit -m "feat: add SQLite schema, migrations and test helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Error types and the jobs queue

**Files:**
- Create: `src/core/errors.ts`, `src/core/jobs/queue.ts`
- Test: `src/core/jobs/queue.test.ts`

**Interfaces:**
- Consumes: `Db`, `jobs`, `Job`, `JobType` (Task 2); `createTestDb`, `seedItem` (Task 2).
- Produces:
  - `errors.ts`: `class TransientError(message, retryAfterMs?)` with `.retryAfterMs?: number`; `class PermanentError(message)`; `class ActionError(message)`; `errorMessage(err: unknown): string`
  - `queue.ts`:
    - `type JobPayloads = { 'triage-draft': Record<string, never>; draft: { feedback?: string }; 'create-linear-issue': Record<string, never>; 'link-linear-issue': { identifier: string; issueId?: string } }`
    - `MAX_ATTEMPTS = 3`, `backoffMs(attempt: number, retryAfterMs?: number): number`
    - `enqueueJob<T extends JobType>(db, type: T, itemId: number, payload: JobPayloads[T], now?: number): Job`
    - `jobPayload<T extends JobType>(job: Job & { type: T }): JobPayloads[T]`
    - `claimNextJob(db, now?): Job | null`
    - `completeJob(db, jobId: number, now?): void`
    - `failJob(db, job: Job, err: unknown, now?): 'rescheduled' | 'failed'`
    - `recoverRunningJobs(db, now?): number`
    - `hasActiveJob(db, itemId: number): boolean`
    - `latestFailedJob(db, itemId: number): Job | undefined`
    - `requeueJob(db, jobId: number, now?): void`

- [ ] **Step 1: Write the failing test** — `src/core/jobs/queue.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import {
  backoffMs,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  hasActiveJob,
  latestFailedJob,
  recoverRunningJobs,
  requeueJob,
} from './queue';

let db: Db;
let itemId: number;

beforeEach(() => {
  db = createTestDb();
  itemId = seedItem(db).id;
});

const getJob = (id: number) => db.select().from(jobs).where(eq(jobs.id, id)).get()!;

describe('backoffMs', () => {
  it('uses 30s, 2m, 10m and honours a longer Retry-After', () => {
    expect([backoffMs(1), backoffMs(2), backoffMs(3)]).toEqual([30_000, 120_000, 600_000]);
    expect(backoffMs(1, 90_000)).toBe(90_000);
    expect(backoffMs(2, 5_000)).toBe(120_000);
  });
});

describe('claimNextJob', () => {
  it('returns null when nothing is due', () => {
    enqueueJob(db, 'draft', itemId, {}, 5_000);
    expect(claimNextJob(db, 4_999)).toBeNull();
  });

  it('claims the oldest due job, marks it running and counts the attempt', () => {
    const first = enqueueJob(db, 'triage-draft', itemId, {}, 1_000);
    enqueueJob(db, 'draft', itemId, {}, 2_000);
    const claimed = claimNextJob(db, 3_000);
    expect(claimed).toMatchObject({ id: first.id, status: 'running', attempts: 1, startedAt: 3_000 });
    expect(claimNextJob(db, 3_000)?.type).toBe('draft');
    expect(claimNextJob(db, 3_000)).toBeNull();
  });
});

describe('failJob', () => {
  it('reschedules transient errors with backoff until attempts run out', () => {
    const job = enqueueJob(db, 'draft', itemId, {}, 0);

    const a1 = claimNextJob(db, 0)!;
    expect(failJob(db, a1, new TransientError('timeout'), 0)).toBe('rescheduled');
    expect(getJob(job.id)).toMatchObject({ status: 'queued', runAfter: 30_000, lastError: 'timeout' });

    const a2 = claimNextJob(db, 30_000)!;
    expect(failJob(db, a2, new Error('socket hang up'), 30_000)).toBe('rescheduled');
    expect(getJob(job.id).runAfter).toBe(150_000);

    const a3 = claimNextJob(db, 150_000)!;
    expect(failJob(db, a3, new TransientError('timeout'), 150_000)).toBe('failed');
    expect(getJob(job.id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('fails permanent errors immediately', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    expect(failJob(db, claimed, new PermanentError('bad output'), 0)).toBe('failed');
    expect(getJob(claimed.id)).toMatchObject({ status: 'failed', lastError: 'bad output' });
  });

  it('respects Retry-After from a rate limit', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new TransientError('rate limited', 300_000), 0);
    expect(getJob(claimed.id).runAfter).toBe(300_000);
  });
});

describe('job bookkeeping', () => {
  it('tracks active jobs per item', () => {
    expect(hasActiveJob(db, itemId)).toBe(false);
    const job = enqueueJob(db, 'draft', itemId, {}, 0);
    expect(hasActiveJob(db, itemId)).toBe(true);
    claimNextJob(db, 0);
    expect(hasActiveJob(db, itemId)).toBe(true);
    completeJob(db, job.id, 1);
    expect(hasActiveJob(db, itemId)).toBe(false);
  });

  it('recovers running jobs after a crash', () => {
    enqueueJob(db, 'draft', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    expect(recoverRunningJobs(db, 10)).toBe(1);
    expect(getJob(claimed.id)).toMatchObject({ status: 'queued', runAfter: 10 });
  });

  it('requeues the latest failed job with a fresh attempt budget', () => {
    enqueueJob(db, 'create-linear-issue', itemId, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new PermanentError('boom'), 0);
    const failed = latestFailedJob(db, itemId)!;
    expect(failed.id).toBe(claimed.id);
    requeueJob(db, failed.id, 50);
    expect(getJob(failed.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: 50, lastError: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/jobs`
Expected: FAIL, cannot resolve `@/core/errors`.

- [ ] **Step 3: Implement `src/core/errors.ts`**

```ts
/** A failure worth retrying later: network errors, 5xx, rate limits. */
export class TransientError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A failure that will not fix itself: bad input, 4xx, invalid Claude output after the retry. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** A user action that is not allowed in the item's current state. Shown to the user as-is. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Implement `src/core/jobs/queue.ts`**

```ts
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Job, type JobType, jobs } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';

export type JobPayloads = {
  'triage-draft': Record<string, never>;
  draft: { feedback?: string };
  'create-linear-issue': Record<string, never>;
  'link-linear-issue': { identifier: string; issueId?: string };
};

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 120_000, 600_000];

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return Math.max(BACKOFF_MS[index]!, retryAfterMs ?? 0);
}

export function enqueueJob<T extends JobType>(
  db: Db,
  type: T,
  itemId: number,
  payload: JobPayloads[T],
  now = Date.now(),
): Job {
  return db
    .insert(jobs)
    .values({ type, itemId, payload, status: 'queued', attempts: 0, runAfter: now, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function jobPayload<T extends JobType>(job: Job & { type: T }): JobPayloads[T] {
  return job.payload as JobPayloads[T];
}

export function claimNextJob(db: Db, now = Date.now()): Job | null {
  return db.transaction((tx) => {
    const next = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.runAfter), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return null;
    return tx
      .update(jobs)
      .set({ status: 'running', attempts: next.attempts + 1, startedAt: now, updatedAt: now })
      .where(eq(jobs.id, next.id))
      .returning()
      .get();
  });
}

export function completeJob(db: Db, jobId: number, now = Date.now()): void {
  db.update(jobs).set({ status: 'done', lastError: null, updatedAt: now }).where(eq(jobs.id, jobId)).run();
}

export function failJob(db: Db, job: Job, err: unknown, now = Date.now()): 'rescheduled' | 'failed' {
  const message = errorMessage(err);
  const transient = !(err instanceof PermanentError);
  if (transient && job.attempts < MAX_ATTEMPTS) {
    const retryAfter = err instanceof TransientError ? err.retryAfterMs : undefined;
    db.update(jobs)
      .set({ status: 'queued', runAfter: now + backoffMs(job.attempts, retryAfter), lastError: message, updatedAt: now })
      .where(eq(jobs.id, job.id))
      .run();
    return 'rescheduled';
  }
  db.update(jobs).set({ status: 'failed', lastError: message, updatedAt: now }).where(eq(jobs.id, job.id)).run();
  return 'failed';
}

/** Single worker: anything still `running` when the worker starts was orphaned by a crash. */
export function recoverRunningJobs(db: Db, now = Date.now()): number {
  return db
    .update(jobs)
    .set({ status: 'queued', runAfter: now, updatedAt: now })
    .where(eq(jobs.status, 'running'))
    .returning({ id: jobs.id })
    .all().length;
}

export function hasActiveJob(db: Db, itemId: number): boolean {
  const row = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), inArray(jobs.status, ['queued', 'running'])))
    .get();
  return row !== undefined;
}

export function latestFailedJob(db: Db, itemId: number): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.status, 'failed')))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .get();
}

export function requeueJob(db: Db, jobId: number, now = Date.now()): void {
  db.update(jobs)
    .set({ status: 'queued', attempts: 0, runAfter: now, lastError: null, updatedAt: now })
    .where(eq(jobs.id, jobId))
    .run();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/jobs && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/errors.ts src/core/jobs
git commit -m "feat: add error types and SQLite jobs queue with backoff" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Source events and the rules engine

**Files:**
- Create: `src/core/events.ts`, `src/core/rules/match.ts`
- Test: `src/core/rules/match.test.ts`

**Interfaces:**
- Consumes: `Rule`, `RuleCategory` (Task 1); `LinearIssueRef` (Task 2).
- Produces:
  - `events.ts`:
    - `type SlackReactionEvent = { source: 'slack'; kind: 'reaction_added'; reaction: string; channel: string; ts: string; threadTs: string }`
    - `type LinearStatusEvent = { source: 'linear'; kind: 'status_changed'; issue: LinearIssueRef; status: string }`
    - `type LinearLabelEvent = { source: 'linear'; kind: 'label_added'; issue: LinearIssueRef; label: string }`
    - `type SourceEvent = SlackReactionEvent | LinearStatusEvent | LinearLabelEvent`
    - `slackEventKey(channel: string, ts: string, reaction: string): string`
    - `linearEventKey(event: LinearStatusEvent | LinearLabelEvent, updatedAt: string): string`
  - `match.ts`: `type RuleMatch = { category: RuleCategory; action?: 'triage-draft' }`, `matchRule(event: SourceEvent, rules: Rule[]): RuleMatch | null`

- [ ] **Step 1: Write the failing test** — `src/core/rules/match.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { Rule } from '@/core/config/schema';
import { type LinearLabelEvent, type LinearStatusEvent, linearEventKey, type SlackReactionEvent, slackEventKey } from '@/core/events';
import { matchRule } from './match';

const issue = { id: 'i1', identifier: 'ENG-1', title: 'Broken', url: 'https://linear.app/x/ENG-1' };
const eyes: SlackReactionEvent = { source: 'slack', kind: 'reaction_added', reaction: 'eyes', channel: 'C1', ts: '2.0', threadTs: '1.0' };
const triageStatus: LinearStatusEvent = { source: 'linear', kind: 'status_changed', issue, status: 'Triage' };
const label: LinearLabelEvent = { source: 'linear', kind: 'label_added', issue, label: 'needs-investigation' };

const rules: Rule[] = [
  { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
  { when: { source: 'slack', reaction: 'eyes' }, category: 'done' },
  { when: { source: 'slack', reaction: 'bookmark' }, category: 'triage' },
  { when: { source: 'linear', status: 'triage' }, category: 'triage' },
  { when: { source: 'linear', label: 'Needs-Investigation' }, category: 'in_progress' },
];

describe('matchRule', () => {
  it('returns the first matching rule with its action', () => {
    expect(matchRule(eyes, rules)).toEqual({ category: 'triage', action: 'triage-draft' });
  });

  it('omits action when the rule has none', () => {
    expect(matchRule({ ...eyes, reaction: 'bookmark' }, rules)).toEqual({ category: 'triage' });
  });

  it('matches Linear status and label names case-insensitively', () => {
    expect(matchRule(triageStatus, rules)).toEqual({ category: 'triage' });
    expect(matchRule(label, rules)).toEqual({ category: 'in_progress' });
  });

  it('does not let a status rule match a label event of the same name', () => {
    expect(matchRule({ ...label, label: 'Triage' }, rules)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchRule({ ...eyes, reaction: 'thumbsup' }, rules)).toBeNull();
    expect(matchRule(eyes, [])).toBeNull();
  });
});

describe('event keys', () => {
  it('builds stable keys', () => {
    expect(slackEventKey('C1', '2.0', 'eyes')).toBe('slack:C1:2.0:eyes');
    expect(linearEventKey(triageStatus, '2026-10-10T10:00:00.000Z')).toBe('linear:i1:status:Triage:2026-10-10T10:00:00.000Z');
    expect(linearEventKey(label, 't')).toBe('linear:i1:label:needs-investigation:t');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/rules`
Expected: FAIL, cannot resolve `@/core/events`.

- [ ] **Step 3: Implement `src/core/events.ts`**

```ts
import type { LinearIssueRef } from './types';

export type SlackReactionEvent = {
  source: 'slack';
  kind: 'reaction_added';
  reaction: string;
  channel: string;
  ts: string;
  threadTs: string;
};

export type LinearStatusEvent = { source: 'linear'; kind: 'status_changed'; issue: LinearIssueRef; status: string };

export type LinearLabelEvent = { source: 'linear'; kind: 'label_added'; issue: LinearIssueRef; label: string };

export type SourceEvent = SlackReactionEvent | LinearStatusEvent | LinearLabelEvent;

export function slackEventKey(channel: string, ts: string, reaction: string): string {
  return `slack:${channel}:${ts}:${reaction}`;
}

export function linearEventKey(event: LinearStatusEvent | LinearLabelEvent, updatedAt: string): string {
  return event.kind === 'status_changed'
    ? `linear:${event.issue.id}:status:${event.status}:${updatedAt}`
    : `linear:${event.issue.id}:label:${event.label}:${updatedAt}`;
}
```

- [ ] **Step 4: Implement `src/core/rules/match.ts`**

```ts
import type { Rule, RuleCategory } from '../config/schema';
import type { SourceEvent } from '../events';

export type RuleMatch = { category: RuleCategory; action?: 'triage-draft' };

export function matchRule(event: SourceEvent, rules: Rule[]): RuleMatch | null {
  for (const rule of rules) {
    if (!whenMatches(rule.when, event)) continue;
    return rule.action ? { category: rule.category, action: rule.action } : { category: rule.category };
  }
  return null;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function whenMatches(when: Rule['when'], event: SourceEvent): boolean {
  if ('reaction' in when) return event.kind === 'reaction_added' && event.reaction === when.reaction;
  if ('status' in when) return event.kind === 'status_changed' && sameName(event.status, when.status);
  return event.kind === 'label_added' && sameName(event.label, when.label);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/rules && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/events.ts src/core/rules
git commit -m "feat: add source events and first-match rules engine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Triage state machine

**Files:**
- Create: `src/core/triage/machine.ts`
- Test: `src/core/triage/machine.test.ts`

**Interfaces:**
- Consumes: `TriageState` (Task 2).
- Produces:
  - `type TriageEvent = { type: 'job_started' } | { type: 'duplicates_found' } | { type: 'no_duplicates' } | { type: 'not_duplicate' } | { type: 'draft_saved' } | { type: 'user_edited' } | { type: 'revise_requested' } | { type: 'approved' } | { type: 'issue_linked' } | { type: 'job_failed' } | { type: 'retry'; to: TriageState }`
  - `type TransitionResult = { ok: true; state: TriageState } | { ok: false; error: string }`
  - `transition(state: TriageState | null, event: TriageEvent): TransitionResult`

- [ ] **Step 1: Write the failing test** — `src/core/triage/machine.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { TriageState } from '@/core/db/schema';
import { type TriageEvent, transition } from './machine';

const ok = (state: TriageState) => ({ ok: true, state });

describe('transition', () => {
  it.each<[TriageState, TriageEvent, TriageState]>([
    ['new', { type: 'job_started' }, 'checking_duplicates'],
    ['checking_duplicates', { type: 'duplicates_found' }, 'duplicate_suspected'],
    ['checking_duplicates', { type: 'no_duplicates' }, 'drafting'],
    ['duplicate_suspected', { type: 'not_duplicate' }, 'drafting'],
    ['drafting', { type: 'draft_saved' }, 'draft_ready'],
    ['draft_ready', { type: 'user_edited' }, 'draft_ready'],
    ['draft_ready', { type: 'revise_requested' }, 'drafting'],
    ['draft_ready', { type: 'approved' }, 'creating_issue'],
    ['creating_issue', { type: 'issue_linked' }, 'linked'],
    ['duplicate_suspected', { type: 'issue_linked' }, 'linked'],
    ['draft_ready', { type: 'issue_linked' }, 'linked'],
    ['drafting', { type: 'job_failed' }, 'failed'],
    ['creating_issue', { type: 'job_failed' }, 'failed'],
    ['failed', { type: 'retry', to: 'creating_issue' }, 'creating_issue'],
  ])('%s + %o → %s', (from, event, to) => {
    expect(transition(from, event)).toEqual(ok(to));
  });

  it('rejects approving while a draft is still being written', () => {
    expect(transition('drafting', { type: 'approved' })).toEqual({
      ok: false,
      error: 'Cannot approved while the item is drafting',
    });
  });

  it('rejects any event for items outside the triage flow', () => {
    expect(transition(null, { type: 'approved' })).toMatchObject({ ok: false });
  });

  it('only retries failed items, and never into failed or linked', () => {
    expect(transition('draft_ready', { type: 'retry', to: 'drafting' }).ok).toBe(false);
    expect(transition('failed', { type: 'retry', to: 'linked' }).ok).toBe(false);
    expect(transition('failed', { type: 'retry', to: 'failed' }).ok).toBe(false);
  });

  it('does not fail an item that is already linked', () => {
    expect(transition('linked', { type: 'job_failed' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/triage`
Expected: FAIL, cannot resolve `./machine`.

- [ ] **Step 3: Implement `src/core/triage/machine.ts`**

```ts
import type { TriageState } from '../db/schema';

export type TriageEvent =
  | { type: 'job_started' }
  | { type: 'duplicates_found' }
  | { type: 'no_duplicates' }
  | { type: 'not_duplicate' }
  | { type: 'draft_saved' }
  | { type: 'user_edited' }
  | { type: 'revise_requested' }
  | { type: 'approved' }
  | { type: 'issue_linked' }
  | { type: 'job_failed' }
  | { type: 'retry'; to: TriageState };

export type TransitionResult = { ok: true; state: TriageState } | { ok: false; error: string };

type SimpleEvent = Exclude<TriageEvent['type'], 'retry'>;

const TABLE: Record<SimpleEvent, { from: readonly TriageState[]; to: TriageState }> = {
  job_started: { from: ['new'], to: 'checking_duplicates' },
  duplicates_found: { from: ['checking_duplicates'], to: 'duplicate_suspected' },
  no_duplicates: { from: ['checking_duplicates'], to: 'drafting' },
  not_duplicate: { from: ['duplicate_suspected'], to: 'drafting' },
  draft_saved: { from: ['drafting'], to: 'draft_ready' },
  user_edited: { from: ['draft_ready'], to: 'draft_ready' },
  revise_requested: { from: ['draft_ready'], to: 'drafting' },
  approved: { from: ['draft_ready'], to: 'creating_issue' },
  issue_linked: { from: ['duplicate_suspected', 'draft_ready', 'creating_issue'], to: 'linked' },
  job_failed: {
    from: ['new', 'checking_duplicates', 'duplicate_suspected', 'drafting', 'draft_ready', 'creating_issue'],
    to: 'failed',
  },
};

export function transition(state: TriageState | null, event: TriageEvent): TransitionResult {
  if (state === null) return { ok: false, error: 'Item is not in the triage flow' };

  if (event.type === 'retry') {
    if (state !== 'failed') return { ok: false, error: `Cannot retry while the item is ${state}` };
    if (event.to === 'failed' || event.to === 'linked') return { ok: false, error: `Cannot retry into ${event.to}` };
    return { ok: true, state: event.to };
  }

  const rule = TABLE[event.type];
  if (!rule.from.includes(state)) {
    return { ok: false, error: `Cannot ${event.type.replaceAll('_', ' ')} while the item is ${state}` };
  }
  return { ok: true, state: rule.to };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/triage && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/triage/machine.ts src/core/triage/machine.test.ts
git commit -m "feat: add triage state machine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Item, draft and cursor repositories plus event ingestion

**Files:**
- Create: `src/core/items.ts`, `src/core/drafts.ts`, `src/core/cursors.ts`, `src/core/ingest.ts`
- Test: `src/core/items.test.ts`, `src/core/drafts.test.ts`, `src/core/ingest.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 (`Db`, tables, `transition`, `enqueueJob`, `matchRule`, `SourceEvent`, errors).
- Produces:
  - `items.ts`:
    - `type ItemPatch = Partial<Omit<NewItem, 'id' | 'createdAt' | 'updatedAt'>>`
    - `getItem(db, id): Item | undefined`, `requireItem(db, id): Item` (throws `ActionError`)
    - `updateItem(db, id, patch: ItemPatch, now?): Item`
    - `logActivity(db, itemId, message, now?): void`, `listActivity(db, itemId): Activity[]`
    - `applyTriageEvent(db, itemId, event: TriageEvent, now?): Item` (throws `ActionError` on invalid transition)
    - `findItemBySlackThread(db, channel, threadTs): Item | undefined`, `findItemByLinearIssue(db, issueId): Item | undefined`
    - `upsertSlackItem(db, thread: { channel: string; threadTs: string }, category: Category, now?): Item`
    - `upsertLinearItem(db, issue: LinearIssueRef, category: Category, now?): Item`
    - `claimLinearIssue(db, itemId, issue: LinearIssueRef, now?): void` (merges a Linear-only owner; throws `PermanentError` if a Slack item owns it)
    - `markItemFailed(db, itemId, fromState: TriageState | null, message: string, now?): void`
  - `drafts.ts`:
    - `type DraftContent = { title: string; problem: string; acceptanceCriteria: string[] }`
    - `saveDraft(db, itemId, content: DraftContent, author: 'claude' | 'user', feedback: string | null, now?): Draft`
    - `latestDraft(db, itemId): Draft | undefined`, `listDrafts(db, itemId): Draft[]`
    - `renderIssueDescription(content: DraftContent): string`
    - `type CandidateInput = { issue: LinearIssueRef; confidence: number; reasoning: string }`
    - `replaceDuplicateCandidates(db, itemId, candidates: CandidateInput[]): void`, `listDuplicateCandidates(db, itemId): DuplicateCandidate[]`
  - `cursors.ts`: `type PollSource = 'slack' | 'linear' | 'config'`; `getCursor(db, source): PollCursor | undefined`; `recordPollSuccess(db, source, cursor: string | null, now?)`; `recordPollError(db, source, message, now?)`; `listCursors(db): PollCursor[]`
  - `ingest.ts`: `type IngestResult = { inserted: boolean; item: Item | null }`; `ingestEvent(db, event: SourceEvent, externalKey: string, rules: Rule[] | null, now?): IngestResult` (`rules = null` records the event without matching); `describeEvent(event): string`

- [ ] **Step 1: Write the failing tests**

`src/core/items.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { ActionError, PermanentError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import {
  applyTriageEvent,
  claimLinearIssue,
  getItem,
  listActivity,
  markItemFailed,
  upsertLinearItem,
  upsertSlackItem,
} from './items';

const issue = { id: 'i1', identifier: 'ENG-1', title: 'Broken export', url: 'https://linear.app/x/ENG-1' };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

describe('upserts', () => {
  it('creates one item per Slack thread and moves it on later matches', () => {
    const a = upsertSlackItem(db, { channel: 'C1', threadTs: '1.0' }, 'triage', 10);
    const b = upsertSlackItem(db, { channel: 'C1', threadTs: '1.0' }, 'done', 20);
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ category: 'done', updatedAt: 20 });
  });

  it('creates Linear items with the issue title and reference', () => {
    const item = upsertLinearItem(db, issue, 'triage', 10);
    expect(item).toMatchObject({ title: 'Broken export', linearIssueId: 'i1', linearIdentifier: 'ENG-1' });
    expect(upsertLinearItem(db, issue, 'in_progress', 20).id).toBe(item.id);
  });
});

describe('applyTriageEvent', () => {
  it('moves the item and rejects invalid events with ActionError', () => {
    const item = seedItem(db, { triageState: 'draft_ready' });
    expect(applyTriageEvent(db, item.id, { type: 'approved' }, 5).triageState).toBe('creating_issue');
    expect(() => applyTriageEvent(db, item.id, { type: 'approved' }, 6)).toThrow(ActionError);
  });
});

describe('claimLinearIssue', () => {
  it('merges a Linear-only item that already owns the issue', () => {
    const linearOnly = upsertLinearItem(db, issue, 'triage', 10);
    const slackItem = seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0' });
    claimLinearIssue(db, slackItem.id, issue, 20);
    expect(getItem(db, slackItem.id)).toMatchObject({ linearIssueId: 'i1', linearIdentifier: 'ENG-1' });
    expect(getItem(db, linearOnly.id)).toMatchObject({ linearIssueId: null, category: 'dismissed' });
    expect(listActivity(db, linearOnly.id).map((a) => a.message)).toContain(`Merged into item #${slackItem.id}`);
  });

  it('refuses to steal an issue linked to another Slack thread', () => {
    seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0', linearIssueId: 'i1' });
    const other = seedItem(db, { slackChannel: 'C1', slackThreadTs: '2.0' });
    expect(() => claimLinearIssue(db, other.id, issue, 20)).toThrow(PermanentError);
  });
});

describe('markItemFailed', () => {
  it('fails the item and remembers where to retry from', () => {
    const item = seedItem(db, { triageState: 'checking_duplicates' });
    markItemFailed(db, item.id, 'new', 'Slack API error: channel_not_found', 30);
    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'failed',
      failedFromState: 'new',
      lastError: 'Slack API error: channel_not_found',
    });
  });

  it('only records the error when the item cannot fail', () => {
    const item = seedItem(db, { triageState: 'linked' });
    markItemFailed(db, item.id, 'linked', 'boom', 30);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', lastError: 'boom' });
  });
});
```

`src/core/drafts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { latestDraft, listDrafts, listDuplicateCandidates, renderIssueDescription, replaceDuplicateCandidates, saveDraft } from './drafts';

const content = { title: 'Export fails', problem: 'CSV export returns 500.', acceptanceCriteria: ['Export succeeds', 'Large files work'] };

describe('drafts', () => {
  it('numbers versions per item', () => {
    const db = createTestDb();
    const item = seedItem(db);
    saveDraft(db, item.id, content, 'claude', null, 1);
    const v2 = saveDraft(db, item.id, { ...content, title: 'Edited' }, 'user', null, 2);
    expect(v2.version).toBe(2);
    expect(latestDraft(db, item.id)).toMatchObject({ version: 2, title: 'Edited', author: 'user' });
    expect(listDrafts(db, item.id).map((d) => d.version)).toEqual([1, 2]);
  });

  it('renders only problem and acceptance criteria', () => {
    expect(renderIssueDescription(content)).toBe(
      '## Problem\nCSV export returns 500.\n\n## Acceptance criteria\n- [ ] Export succeeds\n- [ ] Large files work\n',
    );
  });

  it('replaces duplicate candidates', () => {
    const db = createTestDb();
    const item = seedItem(db);
    const issue = { id: 'i1', identifier: 'ENG-1', title: 'Old', url: 'u' };
    replaceDuplicateCandidates(db, item.id, [{ issue, confidence: 0.9, reasoning: 'same error' }]);
    replaceDuplicateCandidates(db, item.id, [{ issue: { ...issue, id: 'i2', identifier: 'ENG-2' }, confidence: 0.8, reasoning: 'r' }]);
    expect(listDuplicateCandidates(db, item.id).map((c) => c.linearIdentifier)).toEqual(['ENG-2']);
  });
});
```

`src/core/ingest.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { jobs, sourceEvents } from '@/core/db/schema';
import type { LinearStatusEvent, SlackReactionEvent } from '@/core/events';
import { createTestDb } from '@/test/db';
import { ingestEvent } from './ingest';
import { listActivity } from './items';

const rules: Rule[] = [
  { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
  { when: { source: 'linear', status: 'Triage' }, category: 'triage' },
];
const eyes = (ts: string, threadTs = '1.0'): SlackReactionEvent => ({
  source: 'slack', kind: 'reaction_added', reaction: 'eyes', channel: 'C1', ts, threadTs,
});

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

describe('ingestEvent', () => {
  it('creates a triage item and a triage-draft job for 👀', () => {
    const result = ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    expect(result.inserted).toBe(true);
    expect(result.item).toMatchObject({ category: 'triage', triageState: 'new', slackThreadTs: '1.0' });
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'triage-draft', itemId: result.item!.id }]);
    expect(listActivity(db, result.item!.id).map((a) => a.message)).toEqual([':eyes: added in Slack']);
  });

  it('ignores an event it has already seen', () => {
    ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    expect(ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 20)).toEqual({ inserted: false, item: null });
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('reuses the thread item for a 👀 on a reply and does not start a second triage', () => {
    const first = ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', rules, 10);
    const reply = ingestEvent(db, eyes('1.5'), 'slack:C1:1.5:eyes', rules, 20);
    expect(reply.item?.id).toBe(first.item?.id);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('records unmatched events without creating items', () => {
    const result = ingestEvent(db, { ...eyes('1.0'), reaction: 'tada' }, 'slack:C1:1.0:tada', rules, 10);
    expect(result).toEqual({ inserted: true, item: null });
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
  });

  it('records but never matches when rules are null (first-run baseline)', () => {
    expect(ingestEvent(db, eyes('1.0'), 'slack:C1:1.0:eyes', null, 10)).toEqual({ inserted: true, item: null });
  });

  it('creates Linear items without jobs', () => {
    const event: LinearStatusEvent = {
      source: 'linear', kind: 'status_changed', status: 'Triage',
      issue: { id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u' },
    };
    const result = ingestEvent(db, event, 'linear:i1:status:Triage:t', rules, 10);
    expect(result.item).toMatchObject({ linearIdentifier: 'ENG-1', triageState: null, category: 'triage' });
    expect(db.select().from(jobs).all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/items.test.ts src/core/drafts.test.ts src/core/ingest.test.ts`
Expected: FAIL, cannot resolve `./items`, `./drafts`, `./ingest`.

- [ ] **Step 3: Implement `src/core/items.ts`**

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type Activity, activity, type Category, type Item, items, type NewItem, type TriageState } from './db/schema';
import { ActionError, PermanentError } from './errors';
import { type TriageEvent, transition } from './triage/machine';
import type { LinearIssueRef } from './types';

export type ItemPatch = Partial<Omit<NewItem, 'id' | 'createdAt' | 'updatedAt'>>;

export function getItem(db: Db, id: number): Item | undefined {
  return db.select().from(items).where(eq(items.id, id)).get();
}

export function requireItem(db: Db, id: number): Item {
  const item = getItem(db, id);
  if (!item) throw new ActionError(`Item #${id} not found`);
  return item;
}

export function updateItem(db: Db, id: number, patch: ItemPatch, now = Date.now()): Item {
  return db
    .update(items)
    .set({ ...patch, updatedAt: now })
    .where(eq(items.id, id))
    .returning()
    .get();
}

export function logActivity(db: Db, itemId: number, message: string, now = Date.now()): void {
  db.insert(activity).values({ itemId, message, createdAt: now }).run();
}

export function listActivity(db: Db, itemId: number): Activity[] {
  return db.select().from(activity).where(eq(activity.itemId, itemId)).orderBy(asc(activity.id)).all();
}

export function applyTriageEvent(db: Db, itemId: number, event: TriageEvent, now = Date.now()): Item {
  const item = requireItem(db, itemId);
  const result = transition(item.triageState, event);
  if (!result.ok) throw new ActionError(`Item #${itemId}: ${result.error}`);
  return updateItem(db, itemId, { triageState: result.state }, now);
}

export function findItemBySlackThread(db: Db, channel: string, threadTs: string): Item | undefined {
  return db
    .select()
    .from(items)
    .where(and(eq(items.slackChannel, channel), eq(items.slackThreadTs, threadTs)))
    .get();
}

export function findItemByLinearIssue(db: Db, issueId: string): Item | undefined {
  return db.select().from(items).where(eq(items.linearIssueId, issueId)).get();
}

export function upsertSlackItem(
  db: Db,
  thread: { channel: string; threadTs: string },
  category: Category,
  now = Date.now(),
): Item {
  const existing = findItemBySlackThread(db, thread.channel, thread.threadTs);
  if (existing) return updateItem(db, existing.id, { category }, now);
  return db
    .insert(items)
    .values({ category, slackChannel: thread.channel, slackThreadTs: thread.threadTs, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function upsertLinearItem(db: Db, issue: LinearIssueRef, category: Category, now = Date.now()): Item {
  const existing = findItemByLinearIssue(db, issue.id);
  if (existing) return updateItem(db, existing.id, { category }, now);
  return db
    .insert(items)
    .values({
      category,
      title: issue.title,
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Points `itemId` at a Linear issue. If the Linear poller already created a separate,
 * Linear-only item for that issue, that item is merged (dismissed) into this one.
 */
export function claimLinearIssue(db: Db, itemId: number, issue: LinearIssueRef, now = Date.now()): void {
  db.transaction((tx) => {
    const owner = findItemByLinearIssue(tx, issue.id);
    if (owner && owner.id !== itemId) {
      if (owner.slackThreadTs) {
        throw new PermanentError(`${issue.identifier} is already linked to item #${owner.id}`);
      }
      updateItem(tx, owner.id, { linearIssueId: null, linearIdentifier: null, linearUrl: null, category: 'dismissed' }, now);
      logActivity(tx, owner.id, `Merged into item #${itemId}`, now);
    }
    updateItem(tx, itemId, { linearIssueId: issue.id, linearIdentifier: issue.identifier, linearUrl: issue.url }, now);
  });
}

export function markItemFailed(
  db: Db,
  itemId: number,
  fromState: TriageState | null,
  message: string,
  now = Date.now(),
): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const canFail = fromState !== null && transition(item.triageState, { type: 'job_failed' }).ok;
  updateItem(
    db,
    itemId,
    canFail ? { triageState: 'failed', failedFromState: fromState, lastError: message } : { lastError: message },
    now,
  );
  logActivity(db, itemId, `Failed: ${message}`, now);
}
```

- [ ] **Step 4: Implement `src/core/drafts.ts`**

```ts
import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type Draft, type DuplicateCandidate, drafts, duplicateCandidates } from './db/schema';
import type { LinearIssueRef } from './types';

export type DraftContent = { title: string; problem: string; acceptanceCriteria: string[] };

export function latestDraft(db: Db, itemId: number): Draft | undefined {
  return db.select().from(drafts).where(eq(drafts.itemId, itemId)).orderBy(desc(drafts.version)).get();
}

export function listDrafts(db: Db, itemId: number): Draft[] {
  return db.select().from(drafts).where(eq(drafts.itemId, itemId)).orderBy(asc(drafts.version)).all();
}

export function saveDraft(
  db: Db,
  itemId: number,
  content: DraftContent,
  author: 'claude' | 'user',
  feedback: string | null,
  now = Date.now(),
): Draft {
  const version = (latestDraft(db, itemId)?.version ?? 0) + 1;
  return db
    .insert(drafts)
    .values({ itemId, version, ...content, author, feedback, createdAt: now })
    .returning()
    .get();
}

export function renderIssueDescription(content: DraftContent): string {
  const criteria = content.acceptanceCriteria.map((c) => `- [ ] ${c.trim()}`).join('\n');
  return `## Problem\n${content.problem.trim()}\n\n## Acceptance criteria\n${criteria}\n`;
}

export type CandidateInput = { issue: LinearIssueRef; confidence: number; reasoning: string };

export function replaceDuplicateCandidates(db: Db, itemId: number, candidates: CandidateInput[]): void {
  db.transaction((tx) => {
    tx.delete(duplicateCandidates).where(eq(duplicateCandidates.itemId, itemId)).run();
    for (const c of candidates) {
      tx.insert(duplicateCandidates)
        .values({
          itemId,
          linearIssueId: c.issue.id,
          linearIdentifier: c.issue.identifier,
          title: c.issue.title,
          url: c.issue.url,
          confidence: c.confidence,
          reasoning: c.reasoning,
        })
        .run();
    }
  });
}

export function listDuplicateCandidates(db: Db, itemId: number): DuplicateCandidate[] {
  return db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.itemId, itemId))
    .orderBy(desc(duplicateCandidates.confidence))
    .all();
}
```

- [ ] **Step 5: Implement `src/core/cursors.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from './db/client';
import { type PollCursor, pollCursors } from './db/schema';

export type PollSource = 'slack' | 'linear' | 'config';

export function getCursor(db: Db, source: PollSource): PollCursor | undefined {
  return db.select().from(pollCursors).where(eq(pollCursors.source, source)).get();
}

export function listCursors(db: Db): PollCursor[] {
  return db.select().from(pollCursors).all();
}

export function recordPollSuccess(db: Db, source: PollSource, cursor: string | null, now = Date.now()): void {
  db.insert(pollCursors)
    .values({ source, cursor, lastSuccessAt: now, lastError: null, lastErrorAt: null })
    .onConflictDoUpdate({
      target: pollCursors.source,
      set: { cursor, lastSuccessAt: now, lastError: null, lastErrorAt: null },
    })
    .run();
}

/** Keeps the cursor so the next cycle re-reads the same window. */
export function recordPollError(db: Db, source: PollSource, message: string, now = Date.now()): void {
  db.insert(pollCursors)
    .values({ source, lastError: message, lastErrorAt: now })
    .onConflictDoUpdate({ target: pollCursors.source, set: { lastError: message, lastErrorAt: now } })
    .run();
}
```

- [ ] **Step 6: Implement `src/core/ingest.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Rule } from './config/schema';
import type { Db } from './db/client';
import { type Item, sourceEvents } from './db/schema';
import type { SourceEvent } from './events';
import { getItem, logActivity, updateItem, upsertLinearItem, upsertSlackItem } from './items';
import { enqueueJob } from './jobs/queue';
import { matchRule, type RuleMatch } from './rules/match';

export type IngestResult = { inserted: boolean; item: Item | null };

/**
 * Stores the event (deduplicated by `externalKey`) and, when it matches a rule,
 * creates or moves its item and enqueues the rule's action. Runs in one transaction.
 * Pass `rules = null` to record the event as already seen without matching it.
 */
export function ingestEvent(
  db: Db,
  event: SourceEvent,
  externalKey: string,
  rules: Rule[] | null,
  now = Date.now(),
): IngestResult {
  return db.transaction((tx) => {
    const row = tx
      .insert(sourceEvents)
      .values({ source: event.source, kind: event.kind, externalKey, payload: event, seenAt: now })
      .onConflictDoNothing()
      .returning({ id: sourceEvents.id })
      .get();
    if (!row) return { inserted: false, item: null };
    if (!rules) return { inserted: true, item: null };
    const match = matchRule(event, rules);
    if (!match) return { inserted: true, item: null };
    return { inserted: true, item: applyRuleMatch(tx, event, row.id, match, now) };
  });
}

function applyRuleMatch(db: Db, event: SourceEvent, eventId: number, match: RuleMatch, now: number): Item {
  const item =
    event.source === 'slack'
      ? upsertSlackItem(db, { channel: event.channel, threadTs: event.threadTs }, match.category, now)
      : upsertLinearItem(db, event.issue, match.category, now);
  db.update(sourceEvents).set({ itemId: item.id }).where(eq(sourceEvents.id, eventId)).run();
  logActivity(db, item.id, describeEvent(event), now);
  if (match.action === 'triage-draft' && item.triageState === null) {
    updateItem(db, item.id, { triageState: 'new' }, now);
    enqueueJob(db, 'triage-draft', item.id, {}, now);
  }
  return getItem(db, item.id)!;
}

export function describeEvent(event: SourceEvent): string {
  switch (event.kind) {
    case 'reaction_added':
      return `:${event.reaction}: added in Slack`;
    case 'status_changed':
      return `${event.issue.identifier} status → ${event.status}`;
    case 'label_added':
      return `${event.issue.identifier} labeled ${event.label}`;
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/core && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/items.ts src/core/drafts.ts src/core/cursors.ts src/core/ingest.ts src/core/*.test.ts
git commit -m "feat: add item/draft repositories and rule-driven event ingestion" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: User actions

**Files:**
- Create: `src/core/actions/guards.ts`, `approve.ts`, `discard.ts`, `move.ts`, `link.ts`, `not-duplicate.ts`, `revise.ts`, `edit-draft.ts`, `retry.ts`, `index.ts` (all under `src/core/actions/`)
- Test: `src/core/actions/actions.test.ts`

**Interfaces:**
- Consumes: Task 3 queue functions, Task 6 repositories, `CATEGORIES`, `ActionError`.
- Produces (all exported from `@/core/actions`; all throw `ActionError` on invalid input or state; all take an optional trailing `now = Date.now()`):
  - `approve(db, itemId): Item`
  - `discard(db, itemId): Item`
  - `move(db, itemId, category: Category): Item`
  - `link(db, itemId, target: { identifier: string; issueId?: string }): Item`
  - `notDuplicate(db, itemId): Item`
  - `revise(db, itemId, feedback: string): Item`
  - `editDraft(db, itemId, content: DraftContent): Draft`
  - `retry(db, itemId): Item`

- [ ] **Step 1: Write the failing test** — `src/core/actions/actions.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { latestDraft, saveDraft } from '@/core/drafts';
import { ActionError, PermanentError } from '@/core/errors';
import { getItem, markItemFailed } from '@/core/items';
import { claimNextJob, enqueueJob, failJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { approve, discard, editDraft, link, move, notDuplicate, retry, revise } from './index';

const content = { title: 'Export fails', problem: 'CSV export returns 500.', acceptanceCriteria: ['Export succeeds'] };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

const allJobs = () => db.select().from(jobs).all();

function draftReadyItem() {
  const item = seedItem(db, { triageState: 'draft_ready', slackChannel: 'C1', slackThreadTs: '1.0' });
  saveDraft(db, item.id, content, 'claude', null, 1);
  return item;
}

describe('approve', () => {
  it('moves to creating_issue and enqueues one create job, even when clicked twice', () => {
    const item = draftReadyItem();
    expect(approve(db, item.id, 5).triageState).toBe('creating_issue');
    expect(() => approve(db, item.id, 6)).toThrow(ActionError);
    expect(allJobs()).toMatchObject([{ type: 'create-linear-issue', itemId: item.id }]);
  });

  it('requires a draft', () => {
    const item = seedItem(db, { triageState: 'draft_ready' });
    expect(() => approve(db, item.id)).toThrow(/no draft/);
  });
});

describe('link', () => {
  it('enqueues a link job from duplicate_suspected and rejects a second click', () => {
    const item = seedItem(db, { triageState: 'duplicate_suspected' });
    link(db, item.id, { identifier: 'eng-12', issueId: 'i12' }, 5);
    expect(() => link(db, item.id, { identifier: 'ENG-12' }, 6)).toThrow(/already has a job/);
    expect(allJobs()).toMatchObject([{ type: 'link-linear-issue', payload: { identifier: 'ENG-12', issueId: 'i12' } }]);
  });

  it('validates the identifier and the state', () => {
    const ready = draftReadyItem();
    expect(() => link(db, ready.id, { identifier: 'not an id' })).toThrow(/identifier/);
    const drafting = seedItem(db, { triageState: 'drafting' });
    expect(() => link(db, drafting.id, { identifier: 'ENG-1' })).toThrow(ActionError);
  });
});

describe('notDuplicate and revise', () => {
  it('starts a fresh draft after rejecting duplicates', () => {
    const item = seedItem(db, { triageState: 'duplicate_suspected' });
    expect(notDuplicate(db, item.id).triageState).toBe('drafting');
    expect(allJobs()).toMatchObject([{ type: 'draft', payload: {} }]);
  });

  it('passes feedback to the draft job and refuses empty feedback', () => {
    const item = draftReadyItem();
    expect(() => revise(db, item.id, '   ')).toThrow(/feedback/);
    expect(revise(db, item.id, ' focus on mobile ').triageState).toBe('drafting');
    expect(allJobs()).toMatchObject([{ type: 'draft', payload: { feedback: 'focus on mobile' } }]);
  });
});

describe('editDraft', () => {
  it('saves a user version and drops blank criteria', () => {
    const item = draftReadyItem();
    editDraft(db, item.id, { title: ' New title ', problem: 'p', acceptanceCriteria: ['a', '  ', 'b'] }, 5);
    expect(latestDraft(db, item.id)).toMatchObject({
      version: 2, author: 'user', title: 'New title', acceptanceCriteria: ['a', 'b'],
    });
  });

  it('rejects empty content and wrong states', () => {
    const item = draftReadyItem();
    expect(() => editDraft(db, item.id, { ...content, acceptanceCriteria: [' '] })).toThrow(/acceptance criterion/);
    expect(() => editDraft(db, item.id, { ...content, title: '' })).toThrow(/title/);
    const drafting = seedItem(db, { triageState: 'drafting' });
    expect(() => editDraft(db, drafting.id, content)).toThrow(ActionError);
  });
});

describe('discard and move', () => {
  it('dismisses an item once', () => {
    const item = draftReadyItem();
    expect(discard(db, item.id).category).toBe('dismissed');
    expect(() => discard(db, item.id)).toThrow(/already dismissed/);
  });

  it('moves between categories and rejects unknown ones', () => {
    const item = seedItem(db);
    expect(move(db, item.id, 'in_progress').category).toBe('in_progress');
    expect(() => move(db, item.id, 'archived' as never)).toThrow(/Unknown category/);
  });
});

describe('retry', () => {
  it('restores the failed-from state and requeues the failed job', () => {
    const item = seedItem(db, { triageState: 'creating_issue' });
    enqueueJob(db, 'create-linear-issue', item.id, {}, 0);
    const claimed = claimNextJob(db, 0)!;
    failJob(db, claimed, new PermanentError('Linear API error: team not found'), 0);
    markItemFailed(db, item.id, 'creating_issue', 'Linear API error: team not found', 0);

    expect(retry(db, item.id, 10)).toMatchObject({ triageState: 'creating_issue', lastError: null, failedFromState: null });
    expect(allJobs()).toMatchObject([{ id: claimed.id, status: 'queued', attempts: 0 }]);
  });

  it('refuses to retry items that have not failed', () => {
    const item = draftReadyItem();
    expect(() => retry(db, item.id)).toThrow(ActionError);
    expect(getItem(db, item.id)?.triageState).toBe('draft_ready');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/actions`
Expected: FAIL, cannot resolve `./index`.

- [ ] **Step 3: Implement the guards and actions**

`src/core/actions/guards.ts`:
```ts
import type { Db } from '../db/client';
import { ActionError } from '../errors';
import { hasActiveJob } from '../jobs/queue';

export function assertNoActiveJob(db: Db, itemId: number): void {
  if (hasActiveJob(db, itemId)) throw new ActionError(`Item #${itemId} already has a job in progress`);
}
```

`src/core/actions/approve.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { latestDraft } from '../drafts';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity, requireItem } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob } from './guards';

export function approve(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    requireItem(tx, itemId);
    if (!latestDraft(tx, itemId)) throw new ActionError(`Item #${itemId} has no draft to approve`);
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'approved' }, now);
    enqueueJob(tx, 'create-linear-issue', itemId, {}, now);
    logActivity(tx, itemId, 'Draft approved, creating Linear issue', now);
    return item;
  });
}
```

`src/core/actions/discard.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, requireItem, updateItem } from '../items';

export function discard(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (item.category === 'dismissed') throw new ActionError(`Item #${itemId} is already dismissed`);
    const updated = updateItem(tx, itemId, { category: 'dismissed' }, now);
    logActivity(tx, itemId, 'Dismissed', now);
    return updated;
  });
}
```

`src/core/actions/move.ts`:
```ts
import type { Db } from '../db/client';
import { CATEGORIES, type Category, type Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, requireItem, updateItem } from '../items';

export function move(db: Db, itemId: number, category: Category, now = Date.now()): Item {
  if (!CATEGORIES.includes(category)) throw new ActionError(`Unknown category "${category}"`);
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (item.category === category) return item;
    const updated = updateItem(tx, itemId, { category }, now);
    logActivity(tx, itemId, `Moved to ${category}`, now);
    return updated;
  });
}
```

`src/core/actions/link.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { logActivity, requireItem } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob } from './guards';

const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const LINKABLE = ['duplicate_suspected', 'draft_ready'] as const;

export function link(db: Db, itemId: number, target: { identifier: string; issueId?: string }, now = Date.now()): Item {
  const identifier = target.identifier.trim().toUpperCase();
  if (!IDENTIFIER.test(identifier)) throw new ActionError(`"${target.identifier}" is not a Linear identifier like ENG-123`);
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (!LINKABLE.includes(item.triageState as (typeof LINKABLE)[number])) {
      throw new ActionError(`Item #${itemId} can only be linked when a duplicate is suspected or a draft is ready`);
    }
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'link-linear-issue', itemId, target.issueId ? { identifier, issueId: target.issueId } : { identifier }, now);
    logActivity(tx, itemId, `Linking to ${identifier}`, now);
    return item;
  });
}
```

`src/core/actions/not-duplicate.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { applyTriageEvent, logActivity } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob } from './guards';

export function notDuplicate(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'not_duplicate' }, now);
    enqueueJob(tx, 'draft', itemId, {}, now);
    logActivity(tx, itemId, 'Marked as not a duplicate, drafting a new issue', now);
    return item;
  });
}
```

`src/core/actions/revise.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity } from '../items';
import { enqueueJob } from '../jobs/queue';
import { assertNoActiveJob } from './guards';

export function revise(db: Db, itemId: number, feedback: string, now = Date.now()): Item {
  const trimmed = feedback.trim();
  if (!trimmed) throw new ActionError('Revision feedback cannot be empty');
  return db.transaction((tx) => {
    assertNoActiveJob(tx, itemId);
    const item = applyTriageEvent(tx, itemId, { type: 'revise_requested' }, now);
    enqueueJob(tx, 'draft', itemId, { feedback: trimmed }, now);
    logActivity(tx, itemId, `Revision requested: ${trimmed}`, now);
    return item;
  });
}
```

`src/core/actions/edit-draft.ts`:
```ts
import type { Db } from '../db/client';
import type { Draft } from '../db/schema';
import { type DraftContent, saveDraft } from '../drafts';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity } from '../items';

export function editDraft(db: Db, itemId: number, content: DraftContent, now = Date.now()): Draft {
  const clean: DraftContent = {
    title: content.title.trim(),
    problem: content.problem.trim(),
    acceptanceCriteria: content.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
  };
  if (!clean.title) throw new ActionError('Draft title cannot be empty');
  if (!clean.problem) throw new ActionError('Draft problem cannot be empty');
  if (clean.acceptanceCriteria.length === 0) throw new ActionError('Draft needs at least one acceptance criterion');
  return db.transaction((tx) => {
    applyTriageEvent(tx, itemId, { type: 'user_edited' }, now);
    const draft = saveDraft(tx, itemId, clean, 'user', null, now);
    logActivity(tx, itemId, `Draft v${draft.version} edited`, now);
    return draft;
  });
}
```

`src/core/actions/retry.ts`:
```ts
import type { Db } from '../db/client';
import type { Item } from '../db/schema';
import { ActionError } from '../errors';
import { applyTriageEvent, logActivity, requireItem, updateItem } from '../items';
import { latestFailedJob, requeueJob } from '../jobs/queue';

export function retry(db: Db, itemId: number, now = Date.now()): Item {
  return db.transaction((tx) => {
    const item = requireItem(tx, itemId);
    if (item.triageState !== 'failed') throw new ActionError(`Item #${itemId} has not failed`);
    const job = latestFailedJob(tx, itemId);
    if (!job) throw new ActionError(`Item #${itemId} has no failed job to retry`);
    applyTriageEvent(tx, itemId, { type: 'retry', to: item.failedFromState ?? 'new' }, now);
    requeueJob(tx, job.id, now);
    logActivity(tx, itemId, `Retrying ${job.type}`, now);
    return updateItem(tx, itemId, { lastError: null, failedFromState: null }, now);
  });
}
```

`src/core/actions/index.ts`:
```ts
export { approve } from './approve';
export { discard } from './discard';
export { editDraft } from './edit-draft';
export { link } from './link';
export { move } from './move';
export { notDuplicate } from './not-duplicate';
export { retry } from './retry';
export { revise } from './revise';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/actions
git commit -m "feat: add queue actions (approve, link, revise, edit, discard, move, retry)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Client interfaces and the Slack client

**Files:**
- Create: `src/core/clients/types.ts`, `src/core/clients/slack.ts`
- Test: `src/core/clients/slack.test.ts`

**Interfaces:**
- Consumes: `ThreadMessage`, `LinearIssueRef` (Task 2); errors (Task 3).
- Produces (`types.ts`):
  ```ts
  export type SlackReactionItem = { channel: string; ts: string; threadTs: string; reactions: string[] };
  export interface SlackClient {
    authTest(): Promise<{ userId: string; team: string }>;
    listMyReactions(cursor?: string): Promise<{ items: SlackReactionItem[]; nextCursor?: string }>;
    getThread(channel: string, threadTs: string): Promise<ThreadMessage[]>;
    getPermalink(channel: string, ts: string): Promise<string>;
  }
  export type LinearIssueState = LinearIssueRef & { status: string; labels: string[]; updatedAt: string };
  export type LinearCandidate = LinearIssueRef & { status: string; description: string; closedAt: string | null };
  export interface LinearClient {
    viewer(): Promise<{ id: string; name: string }>;
    listMyIssuesUpdatedSince(since: string | null, after?: string): Promise<{ issues: LinearIssueState[]; endCursor: string | null; hasNextPage: boolean }>;
    searchIssues(term: string, teamKey: string, first: number): Promise<LinearCandidate[]>;
    getTeamId(teamKey: string): Promise<string>;
    getIssue(idOrIdentifier: string): Promise<LinearIssueRef | null>;
    createIssue(input: { teamId: string; title: string; description: string }): Promise<LinearIssueRef>;
    attachUrl(issueId: string, url: string, title: string): Promise<void>;
    findIssueByAttachmentUrl(url: string): Promise<LinearIssueRef | null>;
  }
  export type PromptName = 'search-terms' | 'assess-duplicates' | 'draft';
  export interface ClaudeClient {
    run<T>(name: PromptName, vars: Record<string, string>, schema: z.ZodType<T>): Promise<T>;
  }
  ```
- Produces (`slack.ts`): `createSlackClient(token: string): SlackClient`, `mapSlackError(err: unknown): Error`, `toReactionItems(raw: RawReactionItem[], me: string): SlackReactionItem[]`

- [ ] **Step 1: Write `src/core/clients/types.ts`** with exactly the code in the Interfaces block above, preceded by:

```ts
import type { z } from 'zod';
import type { LinearIssueRef, ThreadMessage } from '../types';
```

- [ ] **Step 2: Write the failing test** — `src/core/clients/slack.test.ts`

```ts
import { ErrorCode } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { mapSlackError, toReactionItems } from './slack';

describe('toReactionItems', () => {
  it('keeps only messages with reactions by me and resolves the thread root', () => {
    const raw = [
      {
        type: 'message',
        channel: 'C1',
        message: {
          ts: '2.0',
          thread_ts: '1.0',
          reactions: [
            { name: 'eyes', users: ['U_ME', 'U2'] },
            { name: 'tada', users: ['U2'] },
          ],
        },
      },
      { type: 'message', channel: 'C1', message: { ts: '3.0', reactions: [{ name: 'eyes', users: ['U2'] }] } },
      { type: 'file', channel: 'C1' },
      { type: 'message', channel: 'C2', message: { ts: '4.0', reactions: [{ name: 'bookmark', users: ['U_ME'] }] } },
    ];
    expect(toReactionItems(raw, 'U_ME')).toEqual([
      { channel: 'C1', ts: '2.0', threadTs: '1.0', reactions: ['eyes'] },
      { channel: 'C2', ts: '4.0', threadTs: '4.0', reactions: ['bookmark'] },
    ]);
  });
});

describe('mapSlackError', () => {
  it('maps rate limits to TransientError with Retry-After', () => {
    const err = mapSlackError({ code: ErrorCode.RateLimitedError, retryAfter: 12 });
    expect(err).toBeInstanceOf(TransientError);
    expect((err as TransientError).retryAfterMs).toBe(12_000);
  });

  it('maps platform errors to PermanentError', () => {
    const err = mapSlackError({ code: ErrorCode.PlatformError, data: { error: 'channel_not_found' } });
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Slack API error: channel_not_found');
  });

  it('treats anything else as transient', () => {
    expect(mapSlackError(new Error('ECONNRESET'))).toBeInstanceOf(TransientError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/core/clients/slack.test.ts`
Expected: FAIL, cannot resolve `./slack`.

- [ ] **Step 4: Implement `src/core/clients/slack.ts`**

```ts
import { ErrorCode, WebClient } from '@slack/web-api';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { ThreadMessage } from '../types';
import type { SlackClient, SlackReactionItem } from './types';

export type RawReactionItem = {
  type?: string;
  channel?: string;
  message?: { ts?: string; thread_ts?: string; reactions?: { name?: string; users?: string[] }[] };
};

export function toReactionItems(raw: RawReactionItem[], me: string): SlackReactionItem[] {
  const result: SlackReactionItem[] = [];
  for (const item of raw) {
    if (item.type !== 'message' || !item.channel || !item.message?.ts) continue;
    const mine = (item.message.reactions ?? [])
      .filter((r) => r.name && r.users?.includes(me))
      .map((r) => r.name as string);
    if (mine.length === 0) continue;
    result.push({
      channel: item.channel,
      ts: item.message.ts,
      threadTs: item.message.thread_ts ?? item.message.ts,
      reactions: mine,
    });
  }
  return result;
}

export function mapSlackError(err: unknown): Error {
  const e = err as { code?: string; retryAfter?: number; data?: { error?: string } };
  if (e?.code === ErrorCode.RateLimitedError) return new TransientError('Slack rate limited', (e.retryAfter ?? 30) * 1000);
  if (e?.code === ErrorCode.PlatformError) return new PermanentError(`Slack API error: ${e.data?.error ?? 'unknown'}`);
  return new TransientError(`Slack request failed: ${errorMessage(err)}`);
}

export function createSlackClient(token: string): SlackClient {
  const web = new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
  const names = new Map<string, string>();
  let me: string | undefined;

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapSlackError(err);
    }
  }

  async function myUserId(): Promise<string> {
    me ??= (await call(() => web.auth.test())).user_id as string;
    return me;
  }

  async function userName(userId: string | undefined): Promise<string> {
    if (!userId) return 'unknown';
    const cached = names.get(userId);
    if (cached) return cached;
    try {
      const res = await web.users.info({ user: userId });
      const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
      names.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  return {
    async authTest() {
      const res = await call(() => web.auth.test());
      return { userId: res.user_id as string, team: res.team as string };
    },

    async listMyReactions(cursor) {
      const user = await myUserId();
      const res = await call(() => web.reactions.list({ user, full: true, limit: 100, cursor }));
      return {
        items: toReactionItems((res.items ?? []) as RawReactionItem[], user),
        nextCursor: res.response_metadata?.next_cursor || undefined,
      };
    },

    async getThread(channel, threadTs) {
      const res = await call(() => web.conversations.replies({ channel, ts: threadTs, limit: 200 }));
      const messages: ThreadMessage[] = [];
      for (const m of res.messages ?? []) {
        messages.push({
          ts: m.ts ?? '',
          userName: await userName(m.user ?? m.bot_id),
          text: m.text ?? '',
          files: (m.files ?? []).map((f) => f.name ?? 'file'),
        });
      }
      return messages;
    },

    async getPermalink(channel, ts) {
      const res = await call(() => web.chat.getPermalink({ channel, message_ts: ts }));
      if (!res.permalink) throw new PermanentError('Slack API error: no permalink returned');
      return res.permalink;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/clients && npx tsc --noEmit`
Expected: PASS; tsc clean. If tsc complains about a Slack response field name, open `node_modules/@slack/web-api/dist/types/response/<Method>Response.d.ts` and use the field it declares.

- [ ] **Step 6: Commit**

```bash
git add src/core/clients
git commit -m "feat: add client interfaces and Slack client" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Linear GraphQL client

**Files:**
- Create: `src/core/clients/linear.ts`
- Test: `src/core/clients/linear.test.ts`

**Interfaces:**
- Consumes: `LinearClient`, `LinearIssueState`, `LinearCandidate` (Task 8); errors (Task 3).
- Produces: `createLinearClient(apiKey: string, fetchImpl?: typeof fetch): LinearClient`

- [ ] **Step 1: Write the failing test** — `src/core/clients/linear.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { createLinearClient } from './linear';

function fakeFetch(...responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const fn = vi.fn(async () => {
    const r = responses.shift() ?? { body: { data: {} } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  });
  return fn;
}
const bodyOf = (fn: ReturnType<typeof fakeFetch>, call = 0) =>
  JSON.parse((fn.mock.calls[call] as unknown as [string, RequestInit])[1].body as string);

describe('createLinearClient', () => {
  it('fetches only open issues on the first poll and uses gte afterwards', async () => {
    const page = { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    const fetchFn = fakeFetch({ body: { data: page } }, { body: { data: page } });
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);

    await client.listMyIssuesUpdatedSince(null);
    expect(bodyOf(fetchFn, 0).variables.filter).toMatchObject({ state: { type: { nin: ['completed', 'canceled'] } } });

    await client.listMyIssuesUpdatedSince('2026-10-10T00:00:00.000Z', 'cursor-1');
    expect(bodyOf(fetchFn, 1).variables).toMatchObject({
      after: 'cursor-1',
      filter: { updatedAt: { gte: '2026-10-10T00:00:00.000Z' } },
    });
  });

  it('maps issue nodes', async () => {
    const node = {
      id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u', updatedAt: 't',
      state: { name: 'Triage' }, labels: { nodes: [{ name: 'bug' }] },
    };
    const fetchFn = fakeFetch({ body: { data: { issues: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: 'c2' } } } } });
    const result = await createLinearClient('key', fetchFn as unknown as typeof fetch).listMyIssuesUpdatedSince(null);
    expect(result).toEqual({
      issues: [{ id: 'i1', identifier: 'ENG-1', title: 'Bug', url: 'u', updatedAt: 't', status: 'Triage', labels: ['bug'] }],
      endCursor: 'c2',
      hasNextPage: true,
    });
  });

  it('maps search results with closedAt from completedAt or canceledAt', async () => {
    const nodes = [
      { id: 'a', identifier: 'ENG-1', title: 'A', url: 'u', description: null, completedAt: null, canceledAt: '2026-01-01', state: { name: 'Canceled' } },
    ];
    const fetchFn = fakeFetch({ body: { data: { searchIssues: { nodes } } } });
    const results = await createLinearClient('key', fetchFn as unknown as typeof fetch).searchIssues('export', 'ENG', 15);
    expect(results).toEqual([{ id: 'a', identifier: 'ENG-1', title: 'A', url: 'u', description: '', status: 'Canceled', closedAt: '2026-01-01' }]);
    expect(bodyOf(fetchFn).variables).toMatchObject({ term: 'export', first: 15, filter: { team: { key: { eq: 'ENG' } } } });
  });

  it('turns 429 into TransientError with Retry-After', async () => {
    const fetchFn = fakeFetch({ status: 429, headers: { 'retry-after': '20' } });
    const err = await createLinearClient('key', fetchFn as unknown as typeof fetch).viewer().catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(err.retryAfterMs).toBe(20_000);
  });

  it('turns GraphQL errors into PermanentError, except rate limits', async () => {
    const fetchFn = fakeFetch(
      { status: 400, body: { errors: [{ message: 'Argument Validation Error' }] } },
      { status: 400, body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await expect(client.viewer()).rejects.toBeInstanceOf(PermanentError);
    await expect(client.viewer()).rejects.toBeInstanceOf(TransientError);
  });

  it('returns null from getIssue when the issue does not exist', async () => {
    const fetchFn = fakeFetch({ status: 400, body: { errors: [{ message: 'Entity not found: Issue' }] } });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getIssue('ENG-404')).resolves.toBeNull();
  });

  it('throws when the default team does not exist', async () => {
    const fetchFn = fakeFetch({ body: { data: { teams: { nodes: [] } } } });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getTeamId('NOPE')).rejects.toThrow(
      'Linear team "NOPE" not found',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/clients/linear.test.ts`
Expected: FAIL, cannot resolve `./linear`.

- [ ] **Step 3: Implement `src/core/clients/linear.ts`**

```ts
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { LinearIssueRef } from '../types';
import type { LinearCandidate, LinearClient, LinearIssueState } from './types';

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_REF = 'id identifier title url';

const MY_ISSUES = `query MyIssues($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_REF} updatedAt state { name } labels { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SEARCH = `query Search($term: String!, $filter: IssueFilter, $first: Int) {
  searchIssues(term: $term, filter: $filter, first: $first) {
    nodes { ${ISSUE_REF} description completedAt canceledAt state { name } }
  }
}`;

const TEAM = `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`;
const ISSUE = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_REF} } }`;
const VIEWER = `query Viewer { viewer { id name } }`;
const CREATE = `mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_REF} } }
}`;
const ATTACH = `mutation Attach($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`;
const FOR_URL = `query ForUrl($url: String!) { attachmentsForURL(url: $url) { nodes { issue { ${ISSUE_REF} } } } }`;

type GqlError = { message: string; extensions?: { code?: string } };

function retryAfterMs(res: Response): number | undefined {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

export function createLinearClient(apiKey: string, fetchImpl: typeof fetch = fetch): LinearClient {
  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new TransientError(`Linear request failed: ${errorMessage(err)}`);
    }
    if (res.status === 429) throw new TransientError('Linear rate limited', retryAfterMs(res));
    if (res.status >= 500) throw new TransientError(`Linear server error ${res.status}`);

    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: GqlError[] };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join('; ');
      if (body.errors.some((e) => e.extensions?.code === 'RATELIMITED')) {
        throw new TransientError(`Linear rate limited: ${message}`, 60_000);
      }
      throw new PermanentError(`Linear API error: ${message}`);
    }
    if (!res.ok || !body.data) throw new PermanentError(`Linear request failed with status ${res.status}`);
    return body.data;
  }

  return {
    async viewer() {
      return (await gql<{ viewer: { id: string; name: string } }>(VIEWER)).viewer;
    },

    async listMyIssuesUpdatedSince(since, after) {
      const mine = { or: [{ assignee: { isMe: { eq: true } } }, { creator: { isMe: { eq: true } } }] };
      const filter = since
        ? { ...mine, updatedAt: { gte: since } }
        : { ...mine, state: { type: { nin: ['completed', 'canceled'] } } };
      const data = await gql<{
        issues: {
          nodes: (LinearIssueRef & { updatedAt: string; state: { name: string }; labels: { nodes: { name: string }[] } })[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(MY_ISSUES, { filter, after });
      const issues: LinearIssueState[] = data.issues.nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        updatedAt: n.updatedAt,
        status: n.state.name,
        labels: n.labels.nodes.map((l) => l.name),
      }));
      return { issues, endCursor: data.issues.pageInfo.endCursor, hasNextPage: data.issues.pageInfo.hasNextPage };
    },

    async searchIssues(term, teamKey, first) {
      const data = await gql<{
        searchIssues: {
          nodes: (LinearIssueRef & {
            description: string | null;
            completedAt: string | null;
            canceledAt: string | null;
            state: { name: string };
          })[];
        };
      }>(SEARCH, { term, first, filter: { team: { key: { eq: teamKey } } } });
      return data.searchIssues.nodes.map(
        (n): LinearCandidate => ({
          id: n.id,
          identifier: n.identifier,
          title: n.title,
          url: n.url,
          description: n.description ?? '',
          status: n.state.name,
          closedAt: n.completedAt ?? n.canceledAt ?? null,
        }),
      );
    },

    async getTeamId(teamKey) {
      const data = await gql<{ teams: { nodes: { id: string }[] } }>(TEAM, { key: teamKey });
      const team = data.teams.nodes[0];
      if (!team) throw new PermanentError(`Linear team "${teamKey}" not found`);
      return team.id;
    },

    async getIssue(idOrIdentifier) {
      try {
        return (await gql<{ issue: LinearIssueRef | null }>(ISSUE, { id: idOrIdentifier })).issue;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return null;
        throw err;
      }
    },

    async createIssue(input) {
      const data = await gql<{ issueCreate: { success: boolean; issue: LinearIssueRef | null } }>(CREATE, { input });
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new PermanentError('Linear did not create the issue');
      return data.issueCreate.issue;
    },

    async attachUrl(issueId, url, title) {
      const data = await gql<{ attachmentLinkURL: { success: boolean } }>(ATTACH, { issueId, url, title });
      if (!data.attachmentLinkURL.success) throw new PermanentError('Linear did not attach the URL');
    },

    async findIssueByAttachmentUrl(url) {
      const data = await gql<{ attachmentsForURL: { nodes: { issue: LinearIssueRef }[] } }>(FOR_URL, { url });
      return data.attachmentsForURL.nodes[0]?.issue ?? null;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/clients && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/clients/linear.ts src/core/clients/linear.test.ts
git commit -m "feat: add Linear GraphQL client" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Claude client, output schemas and prompts

**Files:**
- Create: `src/core/clients/claude.ts`, `src/core/triage/schemas.ts`, `prompts/search-terms.md`, `prompts/assess-duplicates.md`, `prompts/draft.md`
- Test: `src/core/clients/claude.test.ts`

**Interfaces:**
- Consumes: `ClaudeClient`, `PromptName` (Task 8); errors (Task 3).
- Produces:
  - `claude.ts`: `type Complete = (prompt: string) => Promise<string>`; `renderPrompt(template: string, vars: Record<string, string>): string`; `extractJson(text: string): unknown`; `createClaudeClient(opts: { complete: Complete; promptsDir?: string }): ClaudeClient`; `sdkComplete(model: () => string | null): Complete`
  - `schemas.ts`: `searchTermsSchema` (`{ queries: string[] }`, 1–3 items), `assessSchema` (`{ duplicates: { identifier: string; confidence: number; reasoning: string }[] }`), `draftSchema` (`{ title: string; problem: string; acceptanceCriteria: string[] }`)
  - Prompt variables: `search-terms` → `thread`; `assess-duplicates` → `thread`, `candidates`; `draft` → `thread`, `previousDraft`, `feedback`

- [ ] **Step 1: Write the failing test** — `src/core/clients/claude.test.ts`

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PermanentError } from '@/core/errors';
import { draftSchema, searchTermsSchema } from '@/core/triage/schemas';
import { createClaudeClient, extractJson, renderPrompt } from './claude';

function promptsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prompts-'));
  writeFileSync(path.join(dir, 'search-terms.md'), 'Thread:\n{{thread}}');
  return dir;
}

describe('renderPrompt', () => {
  it('fills variables and fails on missing ones', () => {
    expect(renderPrompt('a {{x}} b {{x}}', { x: '1' })).toBe('a 1 b 1');
    expect(() => renderPrompt('{{missing}}', {})).toThrow('Missing prompt variable: missing');
  });
});

describe('extractJson', () => {
  it('accepts bare JSON, fenced JSON and JSON with surrounding prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a":{"b":2}}\nThanks')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('createClaudeClient', () => {
  it('renders the prompt file and validates the output', async () => {
    const complete = vi.fn(async () => '{"queries":["csv export 500"]}');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    await expect(client.run('search-terms', { thread: 'hello' }, searchTermsSchema)).resolves.toEqual({
      queries: ['csv export 500'],
    });
    expect(complete).toHaveBeenCalledWith('Thread:\nhello');
  });

  it('retries once with the validation error, then succeeds', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{"queries":[]}').mockResolvedValueOnce('{"queries":["x"]}');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    await expect(client.run('search-terms', { thread: 't' }, searchTermsSchema)).resolves.toEqual({ queries: ['x'] });
    expect(complete.mock.calls[1]?.[0]).toContain('Your previous reply could not be used');
  });

  it('fails permanently after two invalid replies', async () => {
    const complete = vi.fn(async () => 'not json');
    const client = createClaudeClient({ complete, promptsDir: promptsDir() });
    const err = await client.run('search-terms', { thread: 't' }, searchTermsSchema).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toMatch(/invalid output for search-terms/);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('the committed prompts', () => {
  it('render with the variables the handlers pass', async () => {
    const complete = vi.fn(async () => '{"title":"t","problem":"p","acceptanceCriteria":["a"]}');
    const client = createClaudeClient({ complete });
    await client.run('draft', { thread: 'T', previousDraft: '(none)', feedback: '(none)' }, draftSchema);
    expect(complete.mock.calls[0]?.[0]).toContain('T');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/clients/claude.test.ts`
Expected: FAIL, cannot resolve `@/core/triage/schemas`.

- [ ] **Step 3: Implement `src/core/triage/schemas.ts`**

```ts
import { z } from 'zod';

export const searchTermsSchema = z.object({ queries: z.array(z.string().trim().min(1)).min(1).max(3) });

export const assessSchema = z.object({
  duplicates: z.array(
    z.object({ identifier: z.string().min(1), confidence: z.number().min(0).max(1), reasoning: z.string() }),
  ),
});

export const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  problem: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});
```

- [ ] **Step 4: Implement `src/core/clients/claude.ts`**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { ClaudeClient } from './types';

export type Complete = (prompt: string) => Promise<string>;

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable: ${name}`);
    return value;
  });
}

export function extractJson(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/g, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('No JSON object in reply');
  return JSON.parse(unfenced.slice(start, end + 1));
}

function parseOutput<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
}

export function createClaudeClient(opts: { complete: Complete; promptsDir?: string }): ClaudeClient {
  const promptsDir = opts.promptsDir ?? path.join(process.cwd(), 'prompts');
  return {
    async run(name, vars, schema) {
      const prompt = renderPrompt(readFileSync(path.join(promptsDir, `${name}.md`), 'utf8'), vars);
      const first = parseOutput(await opts.complete(prompt), schema);
      if (first.ok) return first.value;
      const retryPrompt = `${prompt}\n\nYour previous reply could not be used: ${first.error}\nReply again with only the JSON object.`;
      const second = parseOutput(await opts.complete(retryPrompt), schema);
      if (second.ok) return second.value;
      throw new PermanentError(`Claude returned invalid output for ${name}: ${second.error}`);
    },
  };
}

/** Runs one tool-less Claude Code turn with the user's Claude Code login. */
export function sdkComplete(model: () => string | null): Complete {
  return async (prompt) => {
    let result: string | undefined;
    try {
      for await (const message of query({
        prompt,
        options: { model: model() ?? undefined, maxTurns: 1, allowedTools: [], settingSources: [] },
      })) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') throw new TransientError(`Claude run ended with ${message.subtype}`);
        result = message.result;
      }
    } catch (err) {
      if (err instanceof TransientError) throw err;
      throw new TransientError(`Claude request failed: ${errorMessage(err)}`);
    }
    if (result === undefined) throw new TransientError('Claude returned no result');
    return result;
  };
}
```

Before moving on, open `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and check the `Options` type. If it has a `tools` option (a list of built-in tools to enable), add `tools: []` next to `allowedTools: []`, so Claude has no tools at all rather than tools that need permission. If `settingSources` doesn't exist, remove it.

- [ ] **Step 5: Write the prompts**

`prompts/search-terms.md`:
```markdown
You help find existing Linear issues that describe the same problem as a Slack thread.

Read the Slack thread and write 1 to 3 short search queries (2–6 words each) that would find an existing Linear issue about the same problem. Prefer exact product terms, feature names and error messages from the thread. Do not add words that are not supported by the thread.

<slack_thread>
{{thread}}
</slack_thread>

Reply with only a JSON object, no prose, in this shape:
{"queries": ["first query", "second query"]}
```

`prompts/assess-duplicates.md`:
```markdown
You decide whether a problem reported in Slack is already tracked by an existing Linear issue.

<slack_thread>
{{thread}}
</slack_thread>

<candidate_issues>
{{candidates}}
</candidate_issues>

For each candidate that is about the same underlying problem, give a confidence between 0 and 1:
- 0.9–1.0: clearly the same problem (same symptom in the same area).
- 0.7–0.9: very likely the same problem, with minor differences in wording or detail.
- 0.4–0.7: related area but probably a different problem.
- below 0.4: leave it out.

Only use identifiers from the candidate list. Keep each reasoning to one or two sentences that name the shared or differing symptom.

Reply with only a JSON object, no prose, in this shape:
{"duplicates": [{"identifier": "ENG-123", "confidence": 0.85, "reasoning": "Both report CSV export returning 500 for large workspaces."}]}
Use {"duplicates": []} when none qualify.
```

`prompts/draft.md`:
```markdown
You write the Linear issue for a problem reported in a Slack thread.

<slack_thread>
{{thread}}
</slack_thread>

<previous_draft>
{{previousDraft}}
</previous_draft>

<reviewer_feedback>
{{feedback}}
</reviewer_feedback>

Rules:
- Describe only the problem: what happens, where, for whom, and the impact. Include concrete details from the thread (error messages, steps, affected customers or areas).
- Do NOT include root-cause guesses, proposed fixes, implementation ideas or investigation plans. Those are written separately.
- Acceptance criteria are observable outcomes that show the problem is solved, one per item, testable by someone who did not read the thread.
- The title is short (under 80 characters) and names the problem, not the solution.
- If a previous draft and feedback are given, revise the previous draft to address the feedback and keep everything the feedback does not mention.

Reply with only a JSON object, no prose, in this shape:
{"title": "...", "problem": "Markdown description of the problem", "acceptanceCriteria": ["...", "..."]}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/core/clients && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/clients/claude.ts src/core/clients/claude.test.ts src/core/triage/schemas.ts prompts
git commit -m "feat: add Claude client with validated JSON output and triage prompts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Test fakes and the Slack poller

**Files:**
- Create: `src/test/fakes.ts`, `src/worker/pollers/slack.ts`
- Test: `src/worker/pollers/slack.test.ts`

**Interfaces:**
- Consumes: client interfaces (Task 8), `configSchema` (Task 1), `ingestEvent` (Task 6), cursors (Task 6), `slackEventKey` (Task 4).
- Produces:
  - `fakes.ts`: `FakeSlack`, `FakeLinear`, `FakeClaude` (classes implementing the interfaces, with the helpers below), `TEST_CONFIG: Config`
    - `FakeSlack.setPages(...pages: SlackReactionItem[][])`, `.listCalls`, `.threads: Map<string, ThreadMessage[]>` keyed `${channel}:${threadTs}`
    - `FakeLinear.setIssuePages(...pages: LinearIssueState[][])`, `.sinceCalls`, `.searchResults: Map<string, LinearCandidate[]>`, `.addIssue(ref)`, `.created`, `.attached`, `.attachmentsByUrl`, `.failures: Partial<Record<keyof LinearClient, Error>>`
    - `FakeClaude.respond(name, ...values)`, `.calls`
  - `pollers/slack.ts`: `pollSlack(deps: { db: Db; slack: SlackClient; config: Config }, now?: number): Promise<{ newEvents: number }>`; `MAX_SLACK_PAGES = 50`

- [ ] **Step 1: Write `src/test/fakes.ts`**

```ts
import type { z } from 'zod';
import type {
  ClaudeClient,
  LinearCandidate,
  LinearClient,
  LinearIssueState,
  PromptName,
  SlackClient,
  SlackReactionItem,
} from '@/core/clients/types';
import { type Config, configSchema } from '@/core/config/schema';
import { PermanentError } from '@/core/errors';
import type { LinearIssueRef, ThreadMessage } from '@/core/types';

export const TEST_CONFIG: Config = configSchema.parse({
  linear: { defaultTeam: 'ENG' },
  rules: [
    { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
    { when: { source: 'slack', reaction: 'bookmark' }, category: 'triage' },
    { when: { source: 'linear', status: 'Triage' }, category: 'triage' },
    { when: { source: 'linear', label: 'needs-investigation' }, category: 'triage' },
  ],
});

export class FakeSlack implements SlackClient {
  pages: { items: SlackReactionItem[]; nextCursor?: string }[] = [];
  listCalls: (string | undefined)[] = [];
  threads = new Map<string, ThreadMessage[]>();

  setPages(...pages: SlackReactionItem[][]): void {
    this.pages = pages.map((items, i) => ({ items, nextCursor: i < pages.length - 1 ? String(i + 1) : undefined }));
  }

  async authTest() {
    return { userId: 'U_ME', team: 'Test' };
  }

  async listMyReactions(cursor?: string) {
    this.listCalls.push(cursor);
    return this.pages[cursor ? Number(cursor) : 0] ?? { items: [] };
  }

  async getThread(channel: string, threadTs: string) {
    const thread = this.threads.get(`${channel}:${threadTs}`);
    if (!thread) throw new PermanentError('Slack API error: thread_not_found');
    return thread;
  }

  async getPermalink(channel: string, ts: string) {
    return `https://slack.test/archives/${channel}/p${ts.replace('.', '')}`;
  }
}

export class FakeLinear implements LinearClient {
  issuePages: { issues: LinearIssueState[]; endCursor: string | null; hasNextPage: boolean }[] = [];
  sinceCalls: (string | null)[] = [];
  searchResults = new Map<string, LinearCandidate[]>();
  issues = new Map<string, LinearIssueRef>();
  attachmentsByUrl = new Map<string, LinearIssueRef>();
  created: { teamId: string; title: string; description: string }[] = [];
  attached: { issueId: string; url: string; title: string }[] = [];
  failures: Partial<Record<keyof LinearClient, Error>> = {};
  private nextNumber = 100;

  private maybeFail(method: keyof LinearClient): void {
    const err = this.failures[method];
    if (err) {
      delete this.failures[method];
      throw err;
    }
  }

  setIssuePages(...pages: LinearIssueState[][]): void {
    this.issuePages = pages.map((issues, i) => ({
      issues,
      endCursor: i < pages.length - 1 ? String(i + 1) : null,
      hasNextPage: i < pages.length - 1,
    }));
  }

  addIssue(ref: LinearIssueRef): void {
    this.issues.set(ref.id, ref);
    this.issues.set(ref.identifier, ref);
  }

  async viewer() {
    return { id: 'me', name: 'Me' };
  }

  async listMyIssuesUpdatedSince(since: string | null, after?: string) {
    this.maybeFail('listMyIssuesUpdatedSince');
    this.sinceCalls.push(since);
    return this.issuePages[after ? Number(after) : 0] ?? { issues: [], endCursor: null, hasNextPage: false };
  }

  async searchIssues(term: string) {
    this.maybeFail('searchIssues');
    return this.searchResults.get(term) ?? [];
  }

  async getTeamId(teamKey: string) {
    this.maybeFail('getTeamId');
    return `team-${teamKey}`;
  }

  async getIssue(idOrIdentifier: string) {
    this.maybeFail('getIssue');
    return this.issues.get(idOrIdentifier) ?? null;
  }

  async createIssue(input: { teamId: string; title: string; description: string }) {
    this.maybeFail('createIssue');
    this.created.push(input);
    const n = this.nextNumber++;
    const ref = { id: `issue-${n}`, identifier: `ENG-${n}`, title: input.title, url: `https://linear.test/ENG-${n}` };
    this.addIssue(ref);
    return ref;
  }

  async attachUrl(issueId: string, url: string, title: string) {
    this.maybeFail('attachUrl');
    this.attached.push({ issueId, url, title });
    const ref = this.issues.get(issueId);
    if (ref) this.attachmentsByUrl.set(url, ref);
  }

  async findIssueByAttachmentUrl(url: string) {
    this.maybeFail('findIssueByAttachmentUrl');
    return this.attachmentsByUrl.get(url) ?? null;
  }
}

export class FakeClaude implements ClaudeClient {
  private responses: Partial<Record<PromptName, unknown[]>> = {};
  calls: { name: PromptName; vars: Record<string, string> }[] = [];

  respond(name: PromptName, ...values: unknown[]): this {
    (this.responses[name] ??= []).push(...values);
    return this;
  }

  async run<T>(name: PromptName, vars: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ name, vars });
    const next = this.responses[name]?.shift();
    if (next === undefined) throw new Error(`FakeClaude: no response queued for ${name}`);
    if (next instanceof Error) throw next;
    return schema.parse(next);
  }
}
```

- [ ] **Step 2: Write the failing test** — `src/worker/pollers/slack.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { items, jobs, sourceEvents } from '@/core/db/schema';
import { getCursor } from '@/core/cursors';
import { createTestDb } from '@/test/db';
import { FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { pollSlack } from './slack';

let db: Db;
let slack: FakeSlack;
beforeEach(() => {
  db = createTestDb();
  slack = new FakeSlack();
});

const eyesOn = (ts: string, threadTs = ts) => ({ channel: 'C1', ts, threadTs, reactions: ['eyes'] });

describe('pollSlack', () => {
  it('records existing reactions on the first run without creating items', async () => {
    slack.setPages([eyesOn('1.0')]);
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 10)).resolves.toEqual({ newEvents: 1 });
    expect(db.select().from(items).all()).toHaveLength(0);
    expect(getCursor(db, 'slack')).toMatchObject({ cursor: 'initialized', lastSuccessAt: 10 });
  });

  it('creates items on the first run when backfill is enabled', async () => {
    slack.setPages([eyesOn('1.0')]);
    const config = { ...TEST_CONFIG, slack: { ...TEST_CONFIG.slack, backfillOnFirstRun: true } };
    await pollSlack({ db, slack, config }, 10);
    expect(db.select().from(items).all()).toHaveLength(1);
  });

  it('creates an item and triage job for a new 👀, and nothing on a repeat poll', async () => {
    slack.setPages([]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);

    slack.setPages([eyesOn('2.0')]);
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 1 });
    await expect(pollSlack({ db, slack, config: TEST_CONFIG }, 30)).resolves.toEqual({ newEvents: 0 });
    expect(db.select().from(items).all()).toMatchObject([{ slackChannel: 'C1', slackThreadTs: '2.0', triageState: 'new' }]);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('stops paging at the first page with nothing new', async () => {
    slack.setPages([eyesOn('1.0')], [eyesOn('0.5')]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);
    expect(slack.listCalls).toEqual([undefined, '1']);

    slack.listCalls = [];
    slack.setPages([eyesOn('3.0'), eyesOn('1.0')], [eyesOn('0.5')]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 20);
    expect(slack.listCalls).toEqual([undefined, '1']);

    slack.listCalls = [];
    await pollSlack({ db, slack, config: TEST_CONFIG }, 30);
    expect(slack.listCalls).toEqual([undefined]);
  });

  it('stores unmatched reactions without creating items', async () => {
    slack.setPages([]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 10);
    slack.setPages([{ channel: 'C1', ts: '5.0', threadTs: '5.0', reactions: ['tada'] }]);
    await pollSlack({ db, slack, config: TEST_CONFIG }, 20);
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
    expect(db.select().from(items).all()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/worker/pollers/slack.test.ts`
Expected: FAIL, cannot resolve `./slack`.

- [ ] **Step 4: Implement `src/worker/pollers/slack.ts`**

```ts
import type { SlackClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import { getCursor, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { type SlackReactionEvent, slackEventKey } from '@/core/events';
import { ingestEvent } from '@/core/ingest';

export const MAX_SLACK_PAGES = 50;

/**
 * Reads the user's reactions newest-first and ingests unseen ones. Slack gives no reaction
 * timestamps, so the first run only records a baseline unless `backfillOnFirstRun` is set.
 */
export async function pollSlack(
  deps: { db: Db; slack: SlackClient; config: Config },
  now = Date.now(),
): Promise<{ newEvents: number }> {
  const { db, slack, config } = deps;
  const firstRun = !getCursor(db, 'slack')?.cursor;
  const rules = firstRun && !config.slack.backfillOnFirstRun ? null : config.rules;
  let newEvents = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SLACK_PAGES; page++) {
    const { items, nextCursor } = await slack.listMyReactions(cursor);
    let pageHadNew = false;
    for (const item of items) {
      for (const reaction of item.reactions) {
        const event: SlackReactionEvent = {
          source: 'slack',
          kind: 'reaction_added',
          reaction,
          channel: item.channel,
          ts: item.ts,
          threadTs: item.threadTs,
        };
        if (ingestEvent(db, event, slackEventKey(item.channel, item.ts, reaction), rules, now).inserted) {
          newEvents++;
          pageHadNew = true;
        }
      }
    }
    if ((!pageHadNew && !firstRun) || !nextCursor) break;
    cursor = nextCursor;
  }

  recordPollSuccess(db, 'slack', 'initialized', now);
  return { newEvents };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/test/fakes.ts src/worker/pollers/slack.ts src/worker/pollers/slack.test.ts
git commit -m "feat: add Slack reaction poller and client fakes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Linear poller

**Files:**
- Create: `src/worker/pollers/linear.ts`
- Test: `src/worker/pollers/linear.test.ts`

**Interfaces:**
- Consumes: `LinearClient`, `LinearIssueState` (Task 8); `ingestEvent` (Task 6); cursors (Task 6); `linearEventKey` (Task 4); fakes (Task 11).
- Produces:
  - `diffIssue(snapshot: LinearIssueSnapshot | undefined, issue: LinearIssueState): { event: LinearStatusEvent | LinearLabelEvent; key: string }[]`
  - `pollLinear(deps: { db: Db; linear: LinearClient; config: Config }, now?: number): Promise<{ newEvents: number }>`

- [ ] **Step 1: Write the failing test** — `src/worker/pollers/linear.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { LinearIssueState } from '@/core/clients/types';
import { getCursor } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { items, sourceEvents } from '@/core/db/schema';
import { createTestDb } from '@/test/db';
import { FakeLinear, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { diffIssue, pollLinear } from './linear';

const issue = (overrides: Partial<LinearIssueState> = {}): LinearIssueState => ({
  id: 'i1', identifier: 'ENG-1', title: 'Export fails', url: 'u',
  status: 'Backlog', labels: [], updatedAt: '2026-10-10T10:00:00.000Z', ...overrides,
});

let db: Db;
let linear: FakeLinear;
beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
});

describe('diffIssue', () => {
  it('emits current status and all labels for an unseen issue', () => {
    expect(diffIssue(undefined, issue({ labels: ['bug'] })).map((d) => d.key)).toEqual([
      'linear:i1:status:Backlog:2026-10-10T10:00:00.000Z',
      'linear:i1:label:bug:2026-10-10T10:00:00.000Z',
    ]);
  });

  it('emits only what changed, and nothing for removed labels', () => {
    const snapshot = { issueId: 'i1', statusName: 'Backlog', labelNames: ['bug', 'old'], updatedAt: 't0' };
    const diffs = diffIssue(snapshot, issue({ status: 'Backlog', labels: ['bug', 'needs-investigation'] }));
    expect(diffs.map((d) => d.event)).toMatchObject([{ kind: 'label_added', label: 'needs-investigation' }]);
    expect(diffIssue(snapshot, issue({ labels: ['bug'] }))).toEqual([]);
  });
});

describe('pollLinear', () => {
  it('queues issues that match a rule and advances the cursor to the newest updatedAt', async () => {
    linear.setIssuePages(
      [issue({ status: 'Triage', updatedAt: '2026-10-10T10:00:00.000Z' })],
      [issue({ id: 'i2', identifier: 'ENG-2', updatedAt: '2026-10-10T11:00:00.000Z' })],
    );
    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 10)).resolves.toEqual({ newEvents: 2 });
    expect(db.select().from(items).all()).toMatchObject([{ linearIdentifier: 'ENG-1', category: 'triage' }]);
    expect(getCursor(db, 'linear')?.cursor).toBe('2026-10-10T11:00:00.000Z');
    expect(linear.sinceCalls).toEqual([null, null]);
  });

  it('passes the cursor on and does not double-count an issue re-delivered at the cursor time', async () => {
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    linear.sinceCalls = [];

    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 0 });
    expect(linear.sinceCalls).toEqual(['2026-10-10T10:00:00.000Z']);
    expect(db.select().from(sourceEvents).all()).toHaveLength(1);
  });

  it('catches a change that happened in the same millisecond as the cursor', async () => {
    linear.setIssuePages([issue({ status: 'Backlog' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await expect(pollLinear({ db, linear, config: TEST_CONFIG }, 20)).resolves.toEqual({ newEvents: 1 });
    expect(db.select().from(items).all()).toHaveLength(1);
  });

  it('updates the Slack item that already owns the issue', async () => {
    const slackItem = seedItem(db, { slackChannel: 'C1', slackThreadTs: '1.0', linearIssueId: 'i1', category: 'done' });
    linear.setIssuePages([issue({ status: 'Triage' })]);
    await pollLinear({ db, linear, config: TEST_CONFIG }, 10);
    expect(db.select().from(items).all()).toMatchObject([{ id: slackItem.id, category: 'triage' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker/pollers/linear.test.ts`
Expected: FAIL, cannot resolve `./linear`.

- [ ] **Step 3: Implement `src/worker/pollers/linear.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { LinearClient, LinearIssueState } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import { getCursor, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { type LinearIssueSnapshot, linearIssueSnapshots } from '@/core/db/schema';
import { type LinearLabelEvent, type LinearStatusEvent, linearEventKey } from '@/core/events';
import { ingestEvent } from '@/core/ingest';

export function diffIssue(
  snapshot: LinearIssueSnapshot | undefined,
  issue: LinearIssueState,
): { event: LinearStatusEvent | LinearLabelEvent; key: string }[] {
  const ref = { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };
  const events: (LinearStatusEvent | LinearLabelEvent)[] = [];
  if (!snapshot || snapshot.statusName !== issue.status) {
    events.push({ source: 'linear', kind: 'status_changed', issue: ref, status: issue.status });
  }
  const before = new Set(snapshot?.labelNames ?? []);
  for (const label of issue.labels) {
    if (!before.has(label)) events.push({ source: 'linear', kind: 'label_added', issue: ref, label });
  }
  return events.map((event) => ({ event, key: linearEventKey(event, issue.updatedAt) }));
}

function getSnapshot(db: Db, issueId: string): LinearIssueSnapshot | undefined {
  return db.select().from(linearIssueSnapshots).where(eq(linearIssueSnapshots.issueId, issueId)).get();
}

function saveSnapshot(db: Db, issue: LinearIssueState): void {
  const values = { statusName: issue.status, labelNames: issue.labels, updatedAt: issue.updatedAt };
  db.insert(linearIssueSnapshots)
    .values({ issueId: issue.id, ...values })
    .onConflictDoUpdate({ target: linearIssueSnapshots.issueId, set: values })
    .run();
}

/**
 * Fetches the user's issues updated at or after the cursor (inclusive, so same-millisecond
 * updates are not lost) and turns snapshot differences into events.
 */
export async function pollLinear(
  deps: { db: Db; linear: LinearClient; config: Config },
  now = Date.now(),
): Promise<{ newEvents: number }> {
  const { db, linear, config } = deps;
  const since = getCursor(db, 'linear')?.cursor ?? null;
  let newest = since;
  let newEvents = 0;
  let after: string | undefined;

  do {
    const page = await linear.listMyIssuesUpdatedSince(since, after);
    for (const issue of page.issues) {
      db.transaction((tx) => {
        for (const { event, key } of diffIssue(getSnapshot(tx, issue.id), issue)) {
          if (ingestEvent(tx, event, key, config.rules, now).inserted) newEvents++;
        }
        saveSnapshot(tx, issue);
      });
      if (!newest || issue.updatedAt > newest) newest = issue.updatedAt;
    }
    after = page.hasNextPage && page.endCursor ? page.endCursor : undefined;
  } while (after);

  recordPollSuccess(db, 'linear', newest, now);
  return { newEvents };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/worker/pollers/linear.ts src/worker/pollers/linear.test.ts
git commit -m "feat: add Linear status/label poller with snapshot diffing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `triage-draft` and `draft` job handlers

**Files:**
- Create: `src/core/triage/format.ts`, `src/worker/handlers/types.ts`, `src/worker/handlers/triage-draft.ts`, `src/worker/handlers/draft.ts`
- Test: `src/core/triage/format.test.ts`, `src/worker/handlers/triage-draft.test.ts`

**Interfaces:**
- Consumes: clients and fakes (Tasks 8–11), repositories (Task 6), queue (Task 3), schemas (Task 10).
- Produces:
  - `format.ts`: `formatThread(messages: ThreadMessage[]): string`, `formatCandidates(candidates: LinearCandidate[]): string`, `formatDraft(draft: DraftContent | undefined): string`, `titleFromText(text: string, max?: number): string`
  - `handlers/types.ts`: `type HandlerContext = { db: Db; config: Config; slack: SlackClient; linear: LinearClient; claude: ClaudeClient; now: () => number }`, `type Handler = (ctx: HandlerContext, job: Job) => Promise<void>`
  - `triageDraftHandler: Handler`, `draftHandler: Handler`

- [ ] **Step 1: Write the failing tests**

`src/core/triage/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatCandidates, formatDraft, formatThread, titleFromText } from './format';

describe('format helpers', () => {
  it('formats a thread with authors and file names', () => {
    expect(
      formatThread([
        { ts: '1', userName: 'ana', text: 'Export is broken', files: ['error.png'] },
        { ts: '2', userName: 'bo', text: 'Same here', files: [] },
      ]),
    ).toBe('[ana] Export is broken (files: error.png)\n\n[bo] Same here');
  });

  it('formats candidates with status and a trimmed description', () => {
    const text = formatCandidates([
      { id: 'i', identifier: 'ENG-1', title: 'Export 500', url: 'u', status: 'Todo', description: 'x'.repeat(600), closedAt: null },
    ]);
    expect(text.startsWith('ENG-1 [Todo] Export 500\n')).toBe(true);
    expect(text.length).toBeLessThan(560);
  });

  it('formats a missing draft as (none)', () => {
    expect(formatDraft(undefined)).toBe('(none)');
    expect(formatDraft({ title: 'T', problem: 'P', acceptanceCriteria: ['A'] })).toBe(
      'Title: T\n\nProblem:\nP\n\nAcceptance criteria:\n- A',
    );
  });

  it('takes the first non-empty line as title, truncated', () => {
    expect(titleFromText('\n  Export fails for big files  \nmore')).toBe('Export fails for big files');
    expect(titleFromText('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(titleFromText('')).toBe('(no text)');
  });
});
```

`src/worker/handlers/triage-draft.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { latestDraft, listDuplicateCandidates, saveDraft } from '@/core/drafts';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { draftHandler } from './draft';
import { triageDraftHandler } from './triage-draft';
import type { HandlerContext } from './types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
let db: Db;
let ctx: HandlerContext;
let slack: FakeSlack;
let linear: FakeLinear;
let claude: FakeClaude;

beforeEach(() => {
  db = createTestDb();
  slack = new FakeSlack();
  linear = new FakeLinear();
  claude = new FakeClaude();
  ctx = { db, config: TEST_CONFIG, slack, linear, claude, now: () => NOW };
  slack.threads.set('C1:1.0', [
    { ts: '1.0', userName: 'ana', text: 'CSV export returns 500\nfor big workspaces', files: [] },
  ]);
});

function newTriageItem() {
  const item = seedItem(db, { triageState: 'new', slackChannel: 'C1', slackThreadTs: '1.0', title: '' });
  enqueueJob(db, 'triage-draft', item.id, {}, 0);
  return { item, job: claimNextJob(db, 0)! };
}

const candidate = (identifier: string, closedAt: string | null = null) => ({
  id: `id-${identifier}`, identifier, title: 'CSV export 500', url: `u/${identifier}`,
  status: 'Todo', description: 'Export fails', closedAt,
});

describe('triageDraftHandler', () => {
  it('goes straight to drafting when Linear has no candidates', async () => {
    const { item, job } = newTriageItem();
    claude.respond('search-terms', { queries: ['csv export 500'] });
    await triageDraftHandler(ctx, job);

    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'drafting',
      title: 'CSV export returns 500',
      slackPermalink: 'https://slack.test/archives/C1/p10',
      slackThread: [{ userName: 'ana' }],
    });
    expect(claude.calls.map((c) => c.name)).toEqual(['search-terms']);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toMatchObject([{ type: 'draft' }]);
  });

  it('stops at duplicate_suspected when a candidate meets the threshold', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-7'), candidate('ENG-8')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    claude.respond('assess-duplicates', {
      duplicates: [
        { identifier: 'ENG-7', confidence: 0.92, reasoning: 'Same 500 on export' },
        { identifier: 'ENG-8', confidence: 0.5, reasoning: 'Related' },
        { identifier: 'ENG-999', confidence: 0.99, reasoning: 'Invented' },
      ],
    });
    await triageDraftHandler(ctx, job);

    expect(getItem(db, item.id)?.triageState).toBe('duplicate_suspected');
    expect(listDuplicateCandidates(db, item.id)).toMatchObject([{ linearIdentifier: 'ENG-7', confidence: 0.92 }]);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toHaveLength(0);
  });

  it('drafts when all candidates are weak', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-8')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    claude.respond('assess-duplicates', { duplicates: [{ identifier: 'ENG-8', confidence: 0.4, reasoning: 'r' }] });
    await triageDraftHandler(ctx, job);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });

  it('ignores issues closed longer ago than searchClosedWithinDays', async () => {
    const { item, job } = newTriageItem();
    linear.searchResults.set('csv export 500', [candidate('ENG-1', '2026-01-01T00:00:00.000Z')]);
    claude.respond('search-terms', { queries: ['csv export 500'] });
    await triageDraftHandler(ctx, job);
    expect(claude.calls.map((c) => c.name)).toEqual(['search-terms']);
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
  });

  it('does nothing for a dismissed item', async () => {
    const { item, job } = newTriageItem();
    updateItem(db, item.id, { category: 'dismissed' });
    await triageDraftHandler(ctx, job);
    expect(claude.calls).toEqual([]);
    expect(getItem(db, item.id)?.triageState).toBe('new');
  });

  it('stops if the item is dismissed while Claude is working', async () => {
    const { item, job } = newTriageItem();
    claude.run = async () => {
      updateItem(db, item.id, { category: 'dismissed' });
      return { queries: ['csv export 500'] } as never;
    };
    await triageDraftHandler(ctx, job);
    expect(db.select().from(jobs).all().filter((j) => j.status === 'queued')).toHaveLength(0);
  });
});

describe('draftHandler', () => {
  it('saves a Claude draft and moves to draft_ready', async () => {
    const item = seedItem(db, {
      triageState: 'drafting',
      slackThread: [{ ts: '1.0', userName: 'ana', text: 'CSV export returns 500', files: [] }],
    });
    enqueueJob(db, 'draft', item.id, {}, 0);
    claude.respond('draft', { title: 'CSV export returns 500', problem: 'Export fails.', acceptanceCriteria: ['Export works'] });
    await draftHandler(ctx, claimNextJob(db, 0)!);

    expect(getItem(db, item.id)?.triageState).toBe('draft_ready');
    expect(latestDraft(db, item.id)).toMatchObject({ version: 1, author: 'claude', title: 'CSV export returns 500' });
    expect(claude.calls[0]?.vars).toMatchObject({ previousDraft: '(none)', feedback: '(none)' });
  });

  it('passes the previous draft and feedback when revising', async () => {
    const item = seedItem(db, { triageState: 'drafting', slackThread: [] });
    saveDraft(db, item.id, { title: 'Old', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    enqueueJob(db, 'draft', item.id, { feedback: 'focus on mobile' }, 0);
    claude.respond('draft', { title: 'New', problem: 'P2', acceptanceCriteria: ['A2'] });
    await draftHandler(ctx, claimNextJob(db, 0)!);

    expect(claude.calls[0]?.vars).toMatchObject({ feedback: 'focus on mobile', previousDraft: expect.stringContaining('Title: Old') });
    expect(latestDraft(db, item.id)).toMatchObject({ version: 2, feedback: 'focus on mobile' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/triage/format.test.ts src/worker/handlers`
Expected: FAIL, cannot resolve `./format` and `./draft`.

- [ ] **Step 3: Implement `src/core/triage/format.ts`**

```ts
import type { LinearCandidate } from '../clients/types';
import type { DraftContent } from '../drafts';
import type { ThreadMessage } from '../types';

export function formatThread(messages: ThreadMessage[]): string {
  return messages
    .map((m) => `[${m.userName}] ${m.text}${m.files.length ? ` (files: ${m.files.join(', ')})` : ''}`)
    .join('\n\n');
}

export function formatCandidates(candidates: LinearCandidate[]): string {
  return candidates
    .map((c) => `${c.identifier} [${c.status}] ${c.title}\n${c.description.slice(0, 500)}`)
    .join('\n---\n');
}

export function formatDraft(draft: DraftContent | undefined): string {
  if (!draft) return '(none)';
  const criteria = draft.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
  return `Title: ${draft.title}\n\nProblem:\n${draft.problem}\n\nAcceptance criteria:\n${criteria}`;
}

export function titleFromText(text: string, max = 120): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return '(no text)';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
```

- [ ] **Step 4: Implement `src/worker/handlers/types.ts`**

```ts
import type { ClaudeClient, LinearClient, SlackClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';

export type HandlerContext = {
  db: Db;
  config: Config;
  slack: SlackClient;
  linear: LinearClient;
  claude: ClaudeClient;
  now: () => number;
};

export type Handler = (ctx: HandlerContext, job: Job) => Promise<void>;
```

- [ ] **Step 5: Implement `src/worker/handlers/triage-draft.ts`**

```ts
import type { LinearCandidate } from '@/core/clients/types';
import { replaceDuplicateCandidates } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { applyTriageEvent, getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob } from '@/core/jobs/queue';
import { formatCandidates, formatThread, titleFromText } from '@/core/triage/format';
import { assessSchema, searchTermsSchema } from '@/core/triage/schemas';
import type { Handler } from './types';

const DAY_MS = 86_400_000;

export const triageDraftHandler: Handler = async (ctx, job) => {
  const { db, slack, linear, claude, config } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (!item.slackChannel || !item.slackThreadTs) throw new PermanentError(`Item #${item.id} has no Slack thread`);
  if (item.triageState === 'new') applyTriageEvent(db, item.id, { type: 'job_started' }, ctx.now());

  const thread = await slack.getThread(item.slackChannel, item.slackThreadTs);
  const permalink = item.slackPermalink ?? (await slack.getPermalink(item.slackChannel, item.slackThreadTs));
  updateItem(db, item.id, { slackThread: thread, slackPermalink: permalink, title: titleFromText(thread[0]?.text ?? '') }, ctx.now());
  const threadText = formatThread(thread);

  const { queries } = await claude.run('search-terms', { thread: threadText }, searchTermsSchema);
  const candidates = new Map<string, LinearCandidate>();
  const oldestClosed = ctx.now() - config.triage.searchClosedWithinDays * DAY_MS;
  for (const q of queries) {
    for (const c of await linear.searchIssues(q, config.linear.defaultTeam, config.triage.maxCandidates)) {
      if (c.closedAt && Date.parse(c.closedAt) < oldestClosed) continue;
      candidates.set(c.identifier, c);
    }
  }
  const shortlist = [...candidates.values()].slice(0, config.triage.maxCandidates);

  let strong: { candidate: LinearCandidate; confidence: number; reasoning: string }[] = [];
  if (shortlist.length > 0) {
    const { duplicates } = await claude.run(
      'assess-duplicates',
      { thread: threadText, candidates: formatCandidates(shortlist) },
      assessSchema,
    );
    strong = duplicates
      .filter((d) => d.confidence >= config.triage.duplicateThreshold && candidates.has(d.identifier))
      .map((d) => ({ candidate: candidates.get(d.identifier)!, confidence: d.confidence, reasoning: d.reasoning }));
  }

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    replaceDuplicateCandidates(
      tx,
      item.id,
      strong.map((s) => ({ issue: s.candidate, confidence: s.confidence, reasoning: s.reasoning })),
    );
    if (strong.length > 0) {
      applyTriageEvent(tx, item.id, { type: 'duplicates_found' }, now);
      logActivity(tx, item.id, `Possible duplicate: ${strong.map((s) => s.candidate.identifier).join(', ')}`, now);
    } else {
      applyTriageEvent(tx, item.id, { type: 'no_duplicates' }, now);
      enqueueJob(tx, 'draft', item.id, {}, now);
      logActivity(tx, item.id, 'No duplicate found, drafting an issue', now);
    }
  });
};
```

- [ ] **Step 6: Implement `src/worker/handlers/draft.ts`**

```ts
import { latestDraft, saveDraft } from '@/core/drafts';
import { applyTriageEvent, getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { formatDraft, formatThread } from '@/core/triage/format';
import { draftSchema } from '@/core/triage/schemas';
import type { Handler } from './types';

export const draftHandler: Handler = async (ctx, job) => {
  const { db, claude } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.triageState !== 'drafting') return;

  const feedback = jobPayload(job as typeof job & { type: 'draft' }).feedback ?? null;
  const output = await claude.run(
    'draft',
    {
      thread: formatThread(item.slackThread ?? []),
      previousDraft: formatDraft(feedback ? latestDraft(db, item.id) : undefined),
      feedback: feedback ?? '(none)',
    },
    draftSchema,
  );

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    const draft = saveDraft(tx, item.id, output, 'claude', feedback, now);
    applyTriageEvent(tx, item.id, { type: 'draft_saved' }, now);
    logActivity(tx, item.id, `Draft v${draft.version} by Claude`, now);
  });
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/triage/format.ts src/core/triage/format.test.ts src/worker/handlers
git commit -m "feat: add triage-draft and draft job handlers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `create-linear-issue` and `link-linear-issue` handlers

**Files:**
- Create: `src/worker/handlers/create-linear-issue.ts`, `src/worker/handlers/link-linear-issue.ts`
- Test: `src/worker/handlers/linear-issue.test.ts`

**Interfaces:**
- Consumes: `Handler` (Task 13), `claimLinearIssue`, `renderIssueDescription` (Task 6), fakes (Task 11).
- Produces: `createLinearIssueHandler: Handler`, `linkLinearIssueHandler: Handler`

- [ ] **Step 1: Write the failing test** — `src/worker/handlers/linear-issue.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { saveDraft } from '@/core/drafts';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, updateItem, upsertLinearItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import { createLinearIssueHandler } from './create-linear-issue';
import { linkLinearIssueHandler } from './link-linear-issue';
import type { HandlerContext } from './types';

const PERMALINK = 'https://slack.test/archives/C1/p10';
let db: Db;
let linear: FakeLinear;
let ctx: HandlerContext;

beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear, claude: new FakeClaude(), now: () => 1_000 };
});

function approvedItem() {
  const item = seedItem(db, { triageState: 'creating_issue', slackChannel: 'C1', slackThreadTs: '1.0', slackPermalink: PERMALINK });
  saveDraft(db, item.id, { title: 'CSV export returns 500', problem: 'Export fails.', acceptanceCriteria: ['Export works'] }, 'claude', null, 1);
  enqueueJob(db, 'create-linear-issue', item.id, {}, 0);
  return { item, job: claimNextJob(db, 0)! };
}

describe('createLinearIssueHandler', () => {
  it('creates the issue in the default team, attaches the thread and links the item', async () => {
    const { item, job } = approvedItem();
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([
      {
        teamId: 'team-ENG',
        title: 'CSV export returns 500',
        description: '## Problem\nExport fails.\n\n## Acceptance criteria\n- [ ] Export works\n',
      },
    ]);
    expect(linear.attached).toEqual([{ issueId: 'issue-100', url: PERMALINK, title: 'Slack thread' }]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIdentifier: 'ENG-100' });
  });

  it('links instead of creating when the thread is already attached to an issue', async () => {
    const { item, job } = approvedItem();
    const existing = { id: 'i9', identifier: 'ENG-9', title: 'Existing', url: 'u9' };
    linear.attachmentsByUrl.set(PERMALINK, existing);
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIdentifier: 'ENG-9' });
  });

  it('does not create a second issue when a retry follows a failed attach', async () => {
    const { item, job } = approvedItem();
    linear.failures.attachUrl = new TransientError('timeout');
    await expect(createLinearIssueHandler(ctx, job)).rejects.toThrow('timeout');
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'creating_issue', linearIdentifier: 'ENG-100' });

    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toHaveLength(1);
    expect(getItem(db, item.id)?.triageState).toBe('linked');
  });

  it('does nothing for a dismissed item', async () => {
    const { item, job } = approvedItem();
    updateItem(db, item.id, { category: 'dismissed' });
    await createLinearIssueHandler(ctx, job);
    expect(linear.created).toEqual([]);
  });
});

describe('linkLinearIssueHandler', () => {
  function linkJob(triageState: 'duplicate_suspected' | 'draft_ready', identifier: string) {
    const item = seedItem(db, { triageState, slackChannel: 'C1', slackThreadTs: '1.0', slackPermalink: PERMALINK });
    enqueueJob(db, 'link-linear-issue', item.id, { identifier }, 0);
    return { item, job: claimNextJob(db, 0)! };
  }

  it('resolves the identifier, attaches the thread and links', async () => {
    linear.addIssue({ id: 'i7', identifier: 'ENG-7', title: 'Export 500', url: 'u7' });
    const { item, job } = linkJob('duplicate_suspected', 'ENG-7');
    await linkLinearIssueHandler(ctx, job);
    expect(linear.attached).toEqual([{ issueId: 'i7', url: PERMALINK, title: 'Slack thread' }]);
    expect(getItem(db, item.id)).toMatchObject({ triageState: 'linked', linearIssueId: 'i7' });
  });

  it('fails permanently for an unknown identifier', async () => {
    const { job } = linkJob('draft_ready', 'ENG-404');
    await expect(linkLinearIssueHandler(ctx, job)).rejects.toBeInstanceOf(PermanentError);
  });

  it('merges the Linear-only item that the poller created for the same issue', async () => {
    const ref = { id: 'i7', identifier: 'ENG-7', title: 'Export 500', url: 'u7' };
    linear.addIssue(ref);
    const linearOnly = upsertLinearItem(db, ref, 'triage', 1);
    const { item, job } = linkJob('duplicate_suspected', 'ENG-7');
    await linkLinearIssueHandler(ctx, job);
    expect(getItem(db, item.id)?.linearIssueId).toBe('i7');
    expect(getItem(db, linearOnly.id)?.category).toBe('dismissed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker/handlers/linear-issue.test.ts`
Expected: FAIL, cannot resolve `./create-linear-issue`.

- [ ] **Step 3: Implement `src/worker/handlers/create-linear-issue.ts`**

```ts
import { latestDraft, renderIssueDescription } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { applyTriageEvent, claimLinearIssue, getItem, logActivity } from '@/core/items';
import type { LinearIssueRef } from '@/core/types';
import type { Handler } from './types';

export const createLinearIssueHandler: Handler = async (ctx, job) => {
  const { db, linear, config } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.triageState !== 'creating_issue') return;
  const draft = latestDraft(db, item.id);
  if (!draft) throw new PermanentError(`Item #${item.id} has no draft`);
  if (!item.slackPermalink) throw new PermanentError(`Item #${item.id} has no Slack permalink`);

  // A previous attempt may have created the issue and then failed. Never create twice.
  let issue: LinearIssueRef | null =
    item.linearIssueId && item.linearIdentifier && item.linearUrl
      ? { id: item.linearIssueId, identifier: item.linearIdentifier, title: draft.title, url: item.linearUrl }
      : null;
  let message = issue ? `Created ${issue.identifier} in Linear` : '';

  if (!issue) {
    issue = await linear.findIssueByAttachmentUrl(item.slackPermalink);
    if (issue) message = `Linked existing ${issue.identifier} (thread already attached)`;
  }
  if (!issue) {
    const teamId = await linear.getTeamId(config.linear.defaultTeam);
    issue = await linear.createIssue({ teamId, title: draft.title, description: renderIssueDescription(draft) });
    claimLinearIssue(db, item.id, issue, ctx.now());
    message = `Created ${issue.identifier} in Linear`;
  }
  if (!message.startsWith('Linked existing')) {
    await linear.attachUrl(issue.id, item.slackPermalink, 'Slack thread');
  }

  const now = ctx.now();
  const linked = issue;
  db.transaction((tx) => {
    claimLinearIssue(tx, item.id, linked, now);
    applyTriageEvent(tx, item.id, { type: 'issue_linked' }, now);
    logActivity(tx, item.id, message, now);
  });
};
```

- [ ] **Step 4: Implement `src/worker/handlers/link-linear-issue.ts`**

```ts
import { PermanentError } from '@/core/errors';
import { applyTriageEvent, claimLinearIssue, getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import type { Handler } from './types';

export const linkLinearIssueHandler: Handler = async (ctx, job) => {
  const { db, linear } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (item.triageState !== 'duplicate_suspected' && item.triageState !== 'draft_ready') return;

  const payload = jobPayload(job as typeof job & { type: 'link-linear-issue' });
  const issue = await linear.getIssue(payload.issueId ?? payload.identifier);
  if (!issue) throw new PermanentError(`Linear issue ${payload.identifier} not found`);
  if (item.slackPermalink) await linear.attachUrl(issue.id, item.slackPermalink, 'Slack thread');

  if (getItem(db, item.id)?.category === 'dismissed') return;
  const now = ctx.now();
  db.transaction((tx) => {
    claimLinearIssue(tx, item.id, issue, now);
    applyTriageEvent(tx, item.id, { type: 'issue_linked' }, now);
    logActivity(tx, item.id, `Linked to ${issue.identifier}`, now);
  });
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/worker/handlers/create-linear-issue.ts src/worker/handlers/link-linear-issue.ts src/worker/handlers/linear-issue.test.ts
git commit -m "feat: add idempotent Linear issue create and link handlers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Worker runner, entry point and smoke script

**Files:**
- Create: `src/worker/runner.ts`, `src/worker/main.ts`, `scripts/smoke.ts`
- Test: `src/worker/runner.test.ts`

**Interfaces:**
- Consumes: everything in `src/worker/**`, queue, cursors, `ConfigStore`, real clients.
- Produces:
  - `HANDLERS: Record<JobType, Handler>`
  - `runNextJob(ctx: HandlerContext, handlers?: Record<JobType, Handler>): Promise<boolean>` (false when no job was due)
  - `pollOnce(deps: { db: Db; slack: SlackClient; linear: LinearClient; configStore: Pick<ConfigStore, 'reload'> }, now?: number): Promise<Config | null>`

- [ ] **Step 1: Write the failing test** — `src/worker/runner.test.ts`

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCursor } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { seedItem } from '@/test/seed';
import type { Handler, HandlerContext } from './handlers/types';
import { HANDLERS, pollOnce, runNextJob } from './runner';

let db: Db;
let ctx: HandlerContext;
beforeEach(() => {
  db = createTestDb();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear: new FakeLinear(), claude: new FakeClaude(), now: () => 1_000 };
});

const withDraftHandler = (handler: Handler) => ({ ...HANDLERS, draft: handler });

describe('runNextJob', () => {
  it('returns false when nothing is due', async () => {
    await expect(runNextJob(ctx)).resolves.toBe(false);
  });

  it('completes a successful job', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    const job = enqueueJob(db, 'draft', item.id, {}, 0);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(true);
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe('done');
  });

  it('reschedules a transient failure and leaves the item state alone', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    enqueueJob(db, 'draft', item.id, {}, 0);
    await runNextJob(ctx, withDraftHandler(async () => { throw new TransientError('Claude busy'); }));
    expect(getItem(db, item.id)?.triageState).toBe('drafting');
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Retrying draft later: Claude busy');
  });

  it('fails the item on a permanent failure, remembering the state the job started from', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    enqueueJob(db, 'draft', item.id, {}, 0);
    await runNextJob(ctx, withDraftHandler(async () => { throw new PermanentError('Claude returned invalid output for draft'); }));
    expect(getItem(db, item.id)).toMatchObject({
      triageState: 'failed',
      failedFromState: 'drafting',
      lastError: 'Claude returned invalid output for draft',
    });
  });
});

describe('pollOnce', () => {
  it('records a config error, keeps polling with the last valid config', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: 'Invalid config: rules.0' }) };
    await expect(pollOnce({ db, slack, linear: new FakeLinear(), configStore }, 10)).resolves.toBe(TEST_CONFIG);
    expect(getCursor(db, 'config')?.lastError).toBe('Invalid config: rules.0');
    expect(getCursor(db, 'slack')?.lastSuccessAt).toBe(10);
  });

  it('isolates poller failures', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const linear = new FakeLinear();
    linear.failures.listMyIssuesUpdatedSince = new TransientError('Linear server error 502');
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: null }) };
    await pollOnce({ db, slack, linear, configStore }, 10);
    expect(getCursor(db, 'linear')?.lastError).toBe('Linear server error 502');
    expect(getCursor(db, 'slack')?.lastError).toBeNull();
  });

  it('skips polling when there has never been a valid config', async () => {
    const slack = new FakeSlack();
    const configStore = { reload: () => ({ config: null, error: 'Cannot read workflow.config.yaml' }) };
    await expect(pollOnce({ db, slack, linear: new FakeLinear(), configStore }, 10)).resolves.toBeNull();
    expect(slack.listCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker/runner.test.ts`
Expected: FAIL, cannot resolve `./runner`.

- [ ] **Step 3: Implement `src/worker/runner.ts`**

```ts
import type { LinearClient, SlackClient } from '@/core/clients/types';
import type { ConfigStore } from '@/core/config/load';
import type { Config } from '@/core/config/schema';
import { type PollSource, recordPollError, recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import type { JobType } from '@/core/db/schema';
import { errorMessage } from '@/core/errors';
import { getItem, logActivity, markItemFailed } from '@/core/items';
import { claimNextJob, completeJob, failJob } from '@/core/jobs/queue';
import { createLinearIssueHandler } from './handlers/create-linear-issue';
import { draftHandler } from './handlers/draft';
import { linkLinearIssueHandler } from './handlers/link-linear-issue';
import { triageDraftHandler } from './handlers/triage-draft';
import type { Handler, HandlerContext } from './handlers/types';
import { pollLinear } from './pollers/linear';
import { pollSlack } from './pollers/slack';

export const HANDLERS: Record<JobType, Handler> = {
  'triage-draft': triageDraftHandler,
  draft: draftHandler,
  'create-linear-issue': createLinearIssueHandler,
  'link-linear-issue': linkLinearIssueHandler,
};

export async function runNextJob(ctx: HandlerContext, handlers: Record<JobType, Handler> = HANDLERS): Promise<boolean> {
  const job = claimNextJob(ctx.db, ctx.now());
  if (!job) return false;
  const startState = getItem(ctx.db, job.itemId)?.triageState ?? null;
  try {
    await handlers[job.type](ctx, job);
    completeJob(ctx.db, job.id, ctx.now());
  } catch (err) {
    const message = errorMessage(err);
    const now = ctx.now();
    if (failJob(ctx.db, job, err, now) === 'failed') {
      markItemFailed(ctx.db, job.itemId, startState, message, now);
    } else {
      logActivity(ctx.db, job.itemId, `Retrying ${job.type} later: ${message}`, now);
    }
  }
  return true;
}

export async function pollOnce(
  deps: { db: Db; slack: SlackClient; linear: LinearClient; configStore: Pick<ConfigStore, 'reload'> },
  now = Date.now(),
): Promise<Config | null> {
  const { db, slack, linear } = deps;
  const { config, error } = deps.configStore.reload();
  if (error) recordPollError(db, 'config', error, now);
  else recordPollSuccess(db, 'config', null, now);
  if (!config) return null;

  const pollers: [PollSource, () => Promise<unknown>][] = [
    ['slack', () => pollSlack({ db, slack, config }, now)],
    ['linear', () => pollLinear({ db, linear, config }, now)],
  ];
  for (const [source, poll] of pollers) {
    try {
      await poll();
    } catch (err) {
      recordPollError(db, source, errorMessage(err), now);
      console.error(`[worker] ${source} poll failed: ${errorMessage(err)}`);
    }
  }
  return config;
}
```

- [ ] **Step 4: Implement `src/worker/main.ts`**

```ts
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
  if (recovered > 0) console.log(`[worker] Requeued ${recovered} job(s) left running by a previous crash`);

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
```

- [ ] **Step 5: Implement `scripts/smoke.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run src && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 7: Smoke-test the worker against real credentials (manual, needs `.env`)**

Run: `npm run smoke`
Expected: three `✓` lines. If `.env` is missing, ask the user to create it from `.env.example`. Don't invent values.

Run: `timeout 20 npm run start:worker`
Expected: `[worker] started`, no crash, and `data/workflow.db` contains `poll_cursors` rows for `slack`, `linear` and `config`. Check with `npm run queue -- list` after Task 16, or now with `node -e "const D=require('better-sqlite3');console.log(new D('data/workflow.db').prepare('select * from poll_cursors').all())"`.

- [ ] **Step 8: Commit**

```bash
git add src/worker/runner.ts src/worker/runner.test.ts src/worker/main.ts scripts/smoke.ts
git commit -m "feat: add worker loop, job runner and credential smoke check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Read queries and the CLI

**Files:**
- Create: `src/core/queries.ts`, `src/cli/program.ts`, `src/cli/main.ts`
- Test: `src/core/queries.test.ts`, `src/cli/program.test.ts`

**Interfaces:**
- Consumes: repositories (Task 6), actions (Task 7), queue (Task 3).
- Produces:
  - `queries.ts`:
    - `listItems(db, opts?: { category?: Category }): Item[]` (no category → everything except `dismissed`, newest `updatedAt` first)
    - `type ItemDetail = { item: Item; drafts: Draft[]; candidates: DuplicateCandidate[]; activity: Activity[]; activeJob: boolean }`
    - `getItemDetail(db, id): ItemDetail | null`
    - `type QueueStatus = { polls: PollCursor[]; queuedJobs: number; failedJobs: number }`, `getQueueStatus(db): QueueStatus`
  - `program.ts`: `buildProgram(db: Db, io: { out: (s: string) => void; err: (s: string) => void }): Command`; `formatItemLine(item: Item): string`

- [ ] **Step 1: Write the failing tests**

`src/core/queries.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { recordPollError } from '@/core/cursors';
import { saveDraft } from '@/core/drafts';
import { PermanentError } from '@/core/errors';
import { claimNextJob, enqueueJob, failJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { getItemDetail, getQueueStatus, listItems } from './queries';

describe('queries', () => {
  it('lists active items newest first and dismissed items only on request', () => {
    const db = createTestDb();
    const older = seedItem(db, { updatedAt: 1 });
    const newer = seedItem(db, { updatedAt: 2 });
    const gone = seedItem(db, { category: 'dismissed' });
    expect(listItems(db).map((i) => i.id)).toEqual([newer.id, older.id]);
    expect(listItems(db, { category: 'dismissed' }).map((i) => i.id)).toEqual([gone.id]);
  });

  it('returns item detail with drafts and job activity', () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'draft_ready' });
    saveDraft(db, item.id, { title: 'T', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    enqueueJob(db, 'create-linear-issue', item.id, {}, 0);
    expect(getItemDetail(db, item.id)).toMatchObject({ item: { id: item.id }, drafts: [{ version: 1 }], activeJob: true });
    expect(getItemDetail(db, 999)).toBeNull();
  });

  it('summarises poll health and job counts', () => {
    const db = createTestDb();
    const item = seedItem(db);
    enqueueJob(db, 'draft', item.id, {}, 0);
    enqueueJob(db, 'draft', item.id, {}, 0);
    failJob(db, claimNextJob(db, 0)!, new PermanentError('x'), 0);
    recordPollError(db, 'linear', 'Linear server error 502', 5);
    expect(getQueueStatus(db)).toMatchObject({
      queuedJobs: 1,
      failedJobs: 1,
      polls: [{ source: 'linear', lastError: 'Linear server error 502' }],
    });
  });
});
```

`src/cli/program.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { saveDraft } from '@/core/drafts';
import { getItem } from '@/core/items';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { buildProgram, formatItemLine } from './program';

function run(db: ReturnType<typeof createTestDb>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram(db, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return program.parseAsync(['node', 'queue', ...args]).then(() => ({ out, err }));
}

describe('queue CLI', () => {
  it('formats one line per item', () => {
    const db = createTestDb();
    const item = seedItem(db, { title: 'Export fails', triageState: 'draft_ready', linearIdentifier: 'ENG-4' });
    expect(formatItemLine(item)).toBe(`#${item.id}\ttriage\tdraft_ready\tENG-4\tExport fails`);
  });

  it('lists items as JSON', async () => {
    const db = createTestDb();
    seedItem(db, { title: 'A' });
    const { out } = await run(db, 'list', '--json');
    expect(JSON.parse(out.join(''))).toMatchObject([{ title: 'A' }]);
  });

  it('approves a draft-ready item', async () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'draft_ready' });
    saveDraft(db, item.id, { title: 'T', problem: 'P', acceptanceCriteria: ['A'] }, 'claude', null, 1);
    const { out } = await run(db, 'approve', String(item.id));
    expect(out.join('')).toContain('creating_issue');
    expect(getItem(db, item.id)?.triageState).toBe('creating_issue');
  });

  it('prints invalid transitions as errors and sets a failing exit code', async () => {
    const db = createTestDb();
    const item = seedItem(db, { triageState: 'drafting' });
    const { err } = await run(db, 'approve', String(item.id));
    expect(err.join('')).toMatch(/^Error: Item #\d+ has no draft/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects non-numeric ids', async () => {
    const db = createTestDb();
    const { err } = await run(db, 'show', 'abc');
    expect(err.join('')).toContain('Item id must be a positive integer');
    process.exitCode = 0;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/queries.test.ts src/cli`
Expected: FAIL, cannot resolve `./queries` and `./program`.

- [ ] **Step 3: Implement `src/core/queries.ts`**

```ts
import { count, desc, eq, ne } from 'drizzle-orm';
import { listCursors } from './cursors';
import type { Db } from './db/client';
import { type Activity, type Category, type Draft, type DuplicateCandidate, type Item, items, jobs, type PollCursor } from './db/schema';
import { listDrafts, listDuplicateCandidates } from './drafts';
import { getItem, listActivity } from './items';
import { hasActiveJob } from './jobs/queue';

export function listItems(db: Db, opts: { category?: Category } = {}): Item[] {
  const where = opts.category ? eq(items.category, opts.category) : ne(items.category, 'dismissed');
  return db.select().from(items).where(where).orderBy(desc(items.updatedAt), desc(items.id)).all();
}

export type ItemDetail = {
  item: Item;
  drafts: Draft[];
  candidates: DuplicateCandidate[];
  activity: Activity[];
  activeJob: boolean;
};

export function getItemDetail(db: Db, id: number): ItemDetail | null {
  const item = getItem(db, id);
  if (!item) return null;
  return {
    item,
    drafts: listDrafts(db, id),
    candidates: listDuplicateCandidates(db, id),
    activity: listActivity(db, id),
    activeJob: hasActiveJob(db, id),
  };
}

export type QueueStatus = { polls: PollCursor[]; queuedJobs: number; failedJobs: number };

export function getQueueStatus(db: Db): QueueStatus {
  const countStatus = (status: 'queued' | 'failed') =>
    db.select({ n: count() }).from(jobs).where(eq(jobs.status, status)).get()?.n ?? 0;
  return { polls: listCursors(db), queuedJobs: countStatus('queued'), failedJobs: countStatus('failed') };
}
```

- [ ] **Step 4: Implement `src/cli/program.ts`**

```ts
import { Command } from 'commander';
import { approve, discard, link, move, retry, revise } from '@/core/actions';
import type { Db } from '@/core/db/client';
import type { Category, Item } from '@/core/db/schema';
import { ActionError, errorMessage } from '@/core/errors';
import { getItemDetail, listItems } from '@/core/queries';

type Io = { out: (s: string) => void; err: (s: string) => void };

export function formatItemLine(item: Item): string {
  return [`#${item.id}`, item.category, item.triageState ?? '-', item.linearIdentifier ?? '-', item.title || '(untitled)'].join('\t');
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ActionError('Item id must be a positive integer');
  return id;
}

export function buildProgram(db: Db, io: Io): Command {
  const program = new Command('queue').description('Inspect and change the workflow queue').exitOverride();

  const run =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        io.err(`Error: ${errorMessage(err)}`);
        process.exitCode = 1;
      }
    };
  const printItem = (item: Item) => io.out(formatItemLine(item));

  program
    .command('list')
    .option('--category <category>', 'triage | in_progress | verification | done | dismissed')
    .option('--json', 'print JSON')
    .action(
      run((opts: { category?: Category; json?: boolean }) => {
        const result = listItems(db, { category: opts.category });
        if (opts.json) io.out(JSON.stringify(result, null, 2));
        else result.forEach(printItem);
      }),
    );

  program
    .command('show <id>')
    .option('--json', 'print JSON')
    .action(
      run((id: string, opts: { json?: boolean }) => {
        const detail = getItemDetail(db, parseId(id));
        if (!detail) throw new ActionError(`Item #${id} not found`);
        if (opts.json) return io.out(JSON.stringify(detail, null, 2));
        printItem(detail.item);
        const draft = detail.drafts.at(-1);
        if (draft) io.out(`\nDraft v${draft.version} (${draft.author}): ${draft.title}\n${draft.problem}\n${draft.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`);
        for (const c of detail.candidates) io.out(`Possible duplicate ${c.linearIdentifier} (${c.confidence}): ${c.reasoning}`);
        if (detail.item.lastError) io.out(`Last error: ${detail.item.lastError}`);
        io.out(`\n${detail.activity.map((a) => `${new Date(a.createdAt).toISOString()}  ${a.message}`).join('\n')}`);
      }),
    );

  program.command('move <id> <category>').action(run((id: string, category: string) => printItem(move(db, parseId(id), category as Category))));
  program.command('approve <id>').action(run((id: string) => printItem(approve(db, parseId(id)))));
  program.command('discard <id>').action(run((id: string) => printItem(discard(db, parseId(id)))));
  program.command('retry <id>').action(run((id: string) => printItem(retry(db, parseId(id)))));
  program.command('link <id> <identifier>').action(run((id: string, identifier: string) => printItem(link(db, parseId(id), { identifier }))));
  program.command('revise <id> <feedback>').action(run((id: string, feedback: string) => printItem(revise(db, parseId(id), feedback))));

  return program;
}
```

- [ ] **Step 5: Implement `src/cli/main.ts`**

```ts
import { CommanderError } from 'commander';
import { getDb } from '@/core/db/client';
import { buildProgram } from './program';

const program = buildProgram(getDb(), { out: (s) => console.log(s), err: (s) => console.error(s) });
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  throw err;
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src && npx tsc --noEmit && npm run queue -- list`
Expected: all PASS; tsc clean; `npm run queue -- list` prints nothing (or existing items) and exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/queries.ts src/core/queries.test.ts src/cli
git commit -m "feat: add read queries and queue CLI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Next.js app, shadcn/ui and the board

Use the `shadcn` and `frontend-design` skills while doing this task. They cover shadcn component usage and visual polish.

**Files:**
- Create: `next.config.ts`, `postcss.config.mjs`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `src/lib/format.ts`, `src/lib/board.ts`, `src/components/board.tsx`, `src/components/item-card.tsx`, `src/components/status-header.tsx`, `src/components/auto-refresh.tsx`
- Generated: `components.json`, `src/lib/utils.ts`, `src/components/ui/*`
- Test: `src/lib/format.test.ts`, `src/lib/board.test.ts`

**Interfaces:**
- Consumes: `getDb`, `listItems`, `getQueueStatus` (Tasks 2, 16); types only from `@/core/db/schema`.
- Produces:
  - `src/lib/format.ts`: `formatAge(fromMs: number, nowMs: number): string`, `CATEGORY_LABELS: Record<Category, string>`, `TRIAGE_STATE_LABELS: Record<TriageState, string>`, `displayTitle(item: Pick<Item, 'title' | 'linearIdentifier' | 'slackChannel'>): string`
  - `src/lib/board.ts`: `BOARD_COLUMNS: readonly Category[]` (`triage`, `in_progress`, `verification`, `done`), `groupByCategory(items: Item[], columns: readonly Category[]): { category: Category; items: Item[] }[]`
  - `src/app/page.tsx` reads `searchParams.item` (a number, used in Task 18) and `searchParams.dismissed` (`'1'` shows the dismissed column)

- [ ] **Step 1: Install the web dependencies and create the Next.js config files**

Run:
```bash
npm install next@16 react react-dom
npm install -D @types/react @types/react-dom tailwindcss @tailwindcss/postcss
```

`next.config.ts`:
```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
```

`postcss.config.mjs`:
```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

`src/app/globals.css`:
```css
@import "tailwindcss";
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'workflow', description: 'Personal task queue' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 2: Initialise shadcn/ui and add the components**

Run:
```bash
npx shadcn@latest init --defaults
npx shadcn@latest add button badge card sheet textarea input label select separator scroll-area
```
Expected: `components.json`, `src/lib/utils.ts` and `src/components/ui/*.tsx` are created, and `src/app/globals.css` gets the theme variables. If `init` asks questions despite `--defaults`, accept the defaults.

- [ ] **Step 3: Write the failing tests**

`src/lib/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { displayTitle, formatAge } from './format';

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    expect(formatAge(0, 45_000)).toBe('45s');
    expect(formatAge(0, 5 * 60_000)).toBe('5m');
    expect(formatAge(0, 3 * 3_600_000)).toBe('3h');
    expect(formatAge(0, 2 * 86_400_000)).toBe('2d');
    expect(formatAge(10, 0)).toBe('0s');
  });
});

describe('displayTitle', () => {
  it('falls back to the Linear identifier, then the Slack channel', () => {
    expect(displayTitle({ title: 'Export fails', linearIdentifier: null, slackChannel: null })).toBe('Export fails');
    expect(displayTitle({ title: '', linearIdentifier: 'ENG-1', slackChannel: null })).toBe('ENG-1');
    expect(displayTitle({ title: '', linearIdentifier: null, slackChannel: 'C1' })).toBe('Slack thread in C1');
    expect(displayTitle({ title: '', linearIdentifier: null, slackChannel: null })).toBe('Untitled');
  });
});
```

`src/lib/board.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Item } from '@/core/db/schema';
import { BOARD_COLUMNS, groupByCategory } from './board';

const item = (id: number, category: Item['category']) => ({ id, category }) as Item;

describe('groupByCategory', () => {
  it('returns every column in order, including empty ones, keeping item order', () => {
    const grouped = groupByCategory([item(1, 'done'), item(2, 'triage'), item(3, 'triage')], BOARD_COLUMNS);
    expect(grouped.map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([
      ['triage', [2, 3]],
      ['in_progress', []],
      ['verification', []],
      ['done', [1]],
    ]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib`
Expected: FAIL, cannot resolve `./format` and `./board`.

- [ ] **Step 5: Implement `src/lib/format.ts` and `src/lib/board.ts`**

`src/lib/format.ts`:
```ts
import type { Category, Item, TriageState } from '@/core/db/schema';

export function formatAge(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  triage: 'Triage',
  in_progress: 'In Progress',
  verification: 'Verification',
  done: 'Done',
  dismissed: 'Dismissed',
};

export const TRIAGE_STATE_LABELS: Record<TriageState, string> = {
  new: 'queued',
  checking_duplicates: 'checking duplicates',
  duplicate_suspected: 'duplicate?',
  drafting: 'drafting',
  draft_ready: 'draft ready',
  creating_issue: 'creating issue',
  linked: 'in Linear',
  failed: 'failed',
};

export function displayTitle(item: Pick<Item, 'title' | 'linearIdentifier' | 'slackChannel'>): string {
  if (item.title) return item.title;
  if (item.linearIdentifier) return item.linearIdentifier;
  if (item.slackChannel) return `Slack thread in ${item.slackChannel}`;
  return 'Untitled';
}
```

`src/lib/board.ts`:
```ts
import type { Category, Item } from '@/core/db/schema';

export const BOARD_COLUMNS = ['triage', 'in_progress', 'verification', 'done'] as const satisfies readonly Category[];

export function groupByCategory(items: Item[], columns: readonly Category[]): { category: Category; items: Item[] }[] {
  return columns.map((category) => ({ category, items: items.filter((i) => i.category === category) }));
}
```

- [ ] **Step 6: Implement the board components**

`src/components/auto-refresh.tsx`:
```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function AutoRefresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
```

`src/components/item-card.tsx`:
```tsx
import Link from 'next/link';
import type { Item } from '@/core/db/schema';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { displayTitle, formatAge, TRIAGE_STATE_LABELS } from '@/lib/format';

export function ItemCard({ item, href, now }: { item: Item; href: string; now: number }) {
  return (
    <Link href={href} scroll={false} className="block">
      <Card className="transition-colors hover:bg-muted/50">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{item.slackThreadTs ? 'Slack' : 'Linear'}</span>
            {item.linearIdentifier && <span className="font-mono">{item.linearIdentifier}</span>}
            <span className="ml-auto">{formatAge(item.createdAt, now)}</span>
          </div>
          <p className="line-clamp-2 text-sm font-medium">{displayTitle(item)}</p>
          {item.triageState && (
            <Badge variant={item.triageState === 'failed' ? 'destructive' : 'secondary'}>
              {TRIAGE_STATE_LABELS[item.triageState]}
            </Badge>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
```

`src/components/board.tsx`:
```tsx
import type { Category, Item } from '@/core/db/schema';
import { groupByCategory } from '@/lib/board';
import { CATEGORY_LABELS } from '@/lib/format';
import { ItemCard } from './item-card';

export function Board({
  items,
  columns,
  hrefFor,
  now,
}: {
  items: Item[];
  columns: readonly Category[];
  hrefFor: (id: number) => string;
  now: number;
}) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(16rem, 1fr))` }}>
      {groupByCategory(items, columns).map((column) => (
        <section key={column.category} className="space-y-3 rounded-lg bg-muted/40 p-3">
          <h2 className="flex items-center justify-between text-sm font-semibold">
            {CATEGORY_LABELS[column.category]}
            <span className="text-muted-foreground">{column.items.length}</span>
          </h2>
          {column.items.map((item) => (
            <ItemCard key={item.id} item={item} href={hrefFor(item.id)} now={now} />
          ))}
        </section>
      ))}
    </div>
  );
}
```

`src/components/status-header.tsx`:
```tsx
import Link from 'next/link';
import type { QueueStatus } from '@/core/queries';
import { formatAge } from '@/lib/format';

const SOURCES = ['slack', 'linear', 'config'] as const;

export function StatusHeader({ status, now, showDismissed }: { status: QueueStatus; now: number; showDismissed: boolean }) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-6 py-3 text-sm">
      <h1 className="text-base font-semibold">workflow</h1>
      {SOURCES.map((source) => {
        const poll = status.polls.find((p) => p.source === source);
        return (
          <span key={source} className={poll?.lastError ? 'text-destructive' : 'text-muted-foreground'} title={poll?.lastError ?? undefined}>
            {source}: {poll?.lastError ? 'error' : poll?.lastSuccessAt ? `ok ${formatAge(poll.lastSuccessAt, now)} ago` : 'never'}
          </span>
        );
      })}
      <span className="text-muted-foreground">{status.queuedJobs} queued</span>
      <span className={status.failedJobs ? 'text-destructive' : 'text-muted-foreground'}>{status.failedJobs} failed</span>
      <Link className="ml-auto underline-offset-4 hover:underline" href={showDismissed ? '/' : '/?dismissed=1'}>
        {showDismissed ? 'Back to board' : 'Show dismissed'}
      </Link>
    </header>
  );
}
```

- [ ] **Step 7: Implement `src/app/page.tsx`**

```tsx
import { AutoRefresh } from '@/components/auto-refresh';
import { Board } from '@/components/board';
import { StatusHeader } from '@/components/status-header';
import { getDb } from '@/core/db/client';
import { getQueueStatus, listItems } from '@/core/queries';
import { BOARD_COLUMNS } from '@/lib/board';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ item?: string; dismissed?: string }>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const db = getDb();
  const now = Date.now();
  const showDismissed = params.dismissed === '1';
  const base = showDismissed ? '/?dismissed=1&' : '/?';

  return (
    <div className="flex min-h-screen flex-col">
      <AutoRefresh />
      <StatusHeader status={getQueueStatus(db)} now={now} showDismissed={showDismissed} />
      <main className="flex-1 overflow-x-auto p-6">
        <Board
          items={listItems(db, showDismissed ? { category: 'dismissed' } : {})}
          columns={showDismissed ? ['dismissed'] : BOARD_COLUMNS}
          hrefFor={(id) => `${base}item=${id}`}
          now={now}
        />
      </main>
    </div>
  );
}
```

Passing `hrefFor` (a function) from a Server Component to `Board` is fine because `Board` and `ItemCard` are Server Components too. Neither has `'use client'`.

- [ ] **Step 8: Run tests, typecheck and build**

Run: `npx vitest run src && npx tsc --noEmit && npm run build`
Expected: tests PASS; tsc clean; `next build` succeeds. If the build fails on better-sqlite3 bundling, confirm `serverExternalPackages` is present in `next.config.ts`.

- [ ] **Step 9: Commit**

```bash
git add next.config.ts postcss.config.mjs components.json package.json package-lock.json src/app src/components src/lib
git commit -m "feat: add Next.js dashboard board with poll status header" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Item sheet and Server Actions

Use the `shadcn` skill for the Sheet, Select and form components, and `vercel-react-best-practices` for client/server boundaries.

**Files:**
- Create: `src/app/actions.ts`, `src/lib/item-actions.ts`
- Create: `src/components/use-action-runner.ts`, `src/components/item-sheet.tsx`, `src/components/thread-preview.tsx`, `src/components/duplicate-panel.tsx`, `src/components/draft-editor.tsx`, `src/components/activity-list.tsx`, `src/components/item-controls.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/lib/item-actions.test.ts`

**Interfaces:**
- Consumes: `@/core/actions` (Task 7), `getItemDetail`/`ItemDetail` (Task 16), labels (Task 17).
- Produces:
  - `src/app/actions.ts` (`'use server'`): `type ActionResult = { error?: string }`, and these, each `Promise<ActionResult>`: `approveAction(itemId)`, `discardAction(itemId)`, `moveAction(itemId, category)`, `linkAction(itemId, identifier, issueId?)`, `notDuplicateAction(itemId)`, `reviseAction(itemId, feedback)`, `editDraftAction(itemId, content: DraftContent)`, `retryAction(itemId)`
  - `src/lib/item-actions.ts`: `type ItemActionFlags = { busy: boolean; canResolveDuplicate: boolean; canEditDraft: boolean; canLink: boolean; canRetry: boolean; canDiscard: boolean }`, `itemActionFlags(item: Pick<Item, 'triageState' | 'category'>, activeJob: boolean): ItemActionFlags`

- [ ] **Step 1: Write the failing test** — `src/lib/item-actions.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { itemActionFlags } from './item-actions';

describe('itemActionFlags', () => {
  it('enables draft editing and linking only when a draft is ready and idle', () => {
    expect(itemActionFlags({ triageState: 'draft_ready', category: 'triage' }, false)).toEqual({
      busy: false, canResolveDuplicate: false, canEditDraft: true, canLink: true, canRetry: false, canDiscard: true,
    });
    expect(itemActionFlags({ triageState: 'draft_ready', category: 'triage' }, true)).toMatchObject({
      busy: true, canEditDraft: false, canLink: false,
    });
  });

  it('enables duplicate resolution for suspected duplicates', () => {
    expect(itemActionFlags({ triageState: 'duplicate_suspected', category: 'triage' }, false)).toMatchObject({
      canResolveDuplicate: true, canLink: true, canEditDraft: false,
    });
  });

  it('marks job-driven states as busy and allows retry only for failed items', () => {
    expect(itemActionFlags({ triageState: 'drafting', category: 'triage' }, false).busy).toBe(true);
    expect(itemActionFlags({ triageState: 'failed', category: 'triage' }, false).canRetry).toBe(true);
  });

  it('cannot discard what is already dismissed', () => {
    expect(itemActionFlags({ triageState: null, category: 'dismissed' }, false).canDiscard).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/item-actions.test.ts`
Expected: FAIL, cannot resolve `./item-actions`.

- [ ] **Step 3: Implement `src/lib/item-actions.ts`**

```ts
import type { Item } from '@/core/db/schema';

export type ItemActionFlags = {
  busy: boolean;
  canResolveDuplicate: boolean;
  canEditDraft: boolean;
  canLink: boolean;
  canRetry: boolean;
  canDiscard: boolean;
};

const JOB_DRIVEN = ['new', 'checking_duplicates', 'drafting', 'creating_issue'];

export function itemActionFlags(item: Pick<Item, 'triageState' | 'category'>, activeJob: boolean): ItemActionFlags {
  const busy = activeJob || JOB_DRIVEN.includes(item.triageState ?? '');
  const state = busy ? null : item.triageState;
  return {
    busy,
    canResolveDuplicate: state === 'duplicate_suspected',
    canEditDraft: state === 'draft_ready',
    canLink: state === 'duplicate_suspected' || state === 'draft_ready',
    canRetry: state === 'failed',
    canDiscard: item.category !== 'dismissed',
  };
}
```

- [ ] **Step 4: Implement `src/app/actions.ts`**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import * as actions from '@/core/actions';
import { getDb } from '@/core/db/client';
import type { Category } from '@/core/db/schema';
import type { DraftContent } from '@/core/drafts';
import { ActionError } from '@/core/errors';

export type ActionResult = { error?: string };

async function perform(fn: () => unknown): Promise<ActionResult> {
  try {
    fn();
  } catch (err) {
    if (err instanceof ActionError) return { error: err.message };
    throw err;
  }
  revalidatePath('/');
  return {};
}

export async function approveAction(itemId: number) {
  return perform(() => actions.approve(getDb(), itemId));
}
export async function discardAction(itemId: number) {
  return perform(() => actions.discard(getDb(), itemId));
}
export async function moveAction(itemId: number, category: Category) {
  return perform(() => actions.move(getDb(), itemId, category));
}
export async function linkAction(itemId: number, identifier: string, issueId?: string) {
  return perform(() => actions.link(getDb(), itemId, { identifier, issueId }));
}
export async function notDuplicateAction(itemId: number) {
  return perform(() => actions.notDuplicate(getDb(), itemId));
}
export async function reviseAction(itemId: number, feedback: string) {
  return perform(() => actions.revise(getDb(), itemId, feedback));
}
export async function editDraftAction(itemId: number, content: DraftContent) {
  return perform(() => actions.editDraft(getDb(), itemId, content));
}
export async function retryAction(itemId: number) {
  return perform(() => actions.retry(getDb(), itemId));
}
```

- [ ] **Step 5: Implement the client components**

`src/components/use-action-runner.ts`:
```ts
'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';

export function useActionRunner() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }
  return { pending, error, run };
}
```

`src/components/thread-preview.tsx`:
```tsx
import type { Item } from '@/core/db/schema';

export function ThreadPreview({ item }: { item: Item }) {
  if (!item.slackThreadTs) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Slack thread</h3>
        {item.slackPermalink && (
          <a className="text-sm underline-offset-4 hover:underline" href={item.slackPermalink} target="_blank" rel="noreferrer">
            Open in Slack
          </a>
        )}
      </div>
      {item.slackThread?.length ? (
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3 text-sm">
          {item.slackThread.map((m) => (
            <li key={m.ts}>
              <span className="font-medium">{m.userName}</span>{' '}
              <span className="whitespace-pre-wrap">{m.text}</span>
              {m.files.length > 0 && <span className="text-muted-foreground"> ({m.files.join(', ')})</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Thread not fetched yet.</p>
      )}
    </section>
  );
}
```

`src/components/duplicate-panel.tsx`:
```tsx
'use client';

import { linkAction, notDuplicateAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { DuplicateCandidate } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function DuplicatePanel({ itemId, candidates, enabled }: { itemId: number; candidates: DuplicateCandidate[]; enabled: boolean }) {
  const { pending, error, run } = useActionRunner();
  if (candidates.length === 0) return null;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Possible duplicates</h3>
      {candidates.map((c) => (
        <div key={c.id} className="space-y-2 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <a className="font-mono underline-offset-4 hover:underline" href={c.url} target="_blank" rel="noreferrer">
              {c.linearIdentifier}
            </a>
            <span className="truncate">{c.title}</span>
            <span className="ml-auto text-muted-foreground">{Math.round(c.confidence * 100)}%</span>
          </div>
          <p className="text-muted-foreground">{c.reasoning}</p>
          {enabled && (
            <Button size="sm" disabled={pending} onClick={() => run(() => linkAction(itemId, c.linearIdentifier, c.linearIssueId))}>
              Link to {c.linearIdentifier}
            </Button>
          )}
        </div>
      ))}
      {enabled && (
        <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => notDuplicateAction(itemId))}>
          Not a duplicate
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
```

`src/components/draft-editor.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { approveAction, editDraftAction, reviseAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Draft } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function DraftEditor({ itemId, drafts, editable }: { itemId: number; drafts: Draft[]; editable: boolean }) {
  const latest = drafts.at(-1);
  const [selected, setSelected] = useState<number | null>(null);
  if (!latest) return null;
  const shown = drafts.find((d) => d.version === selected) ?? latest;
  const isLatest = shown.version === latest.version;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Draft issue</h3>
        <Select value={String(shown.version)} onValueChange={(v) => setSelected(Number(v))}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {drafts.map((d) => (
              <SelectItem key={d.id} value={String(d.version)}>
                v{d.version} by {d.author}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isLatest && editable ? <DraftForm key={latest.id} itemId={itemId} draft={latest} /> : <DraftView draft={shown} />}
    </section>
  );
}

function DraftView({ draft }: { draft: Draft }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{draft.title}</p>
      <p className="whitespace-pre-wrap">{draft.problem}</p>
      <ul className="list-disc pl-5">
        {draft.acceptanceCriteria.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {draft.feedback && <p className="text-muted-foreground">Feedback: {draft.feedback}</p>}
    </div>
  );
}

function DraftForm({ itemId, draft }: { itemId: number; draft: Draft }) {
  const [title, setTitle] = useState(draft.title);
  const [problem, setProblem] = useState(draft.problem);
  const [criteria, setCriteria] = useState<string[]>(draft.acceptanceCriteria);
  const [feedback, setFeedback] = useState('');
  const { pending, error, run } = useActionRunner();

  const content = { title, problem, acceptanceCriteria: criteria };
  const dirty =
    title !== draft.title || problem !== draft.problem || JSON.stringify(criteria) !== JSON.stringify(draft.acceptanceCriteria);
  const setCriterion = (index: number, value: string) => setCriteria((cs) => cs.map((c, i) => (i === index ? value : c)));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="draft-title">Title</Label>
        <Input id="draft-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="draft-problem">Problem</Label>
        <Textarea id="draft-problem" rows={8} value={problem} onChange={(e) => setProblem(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Acceptance criteria</Label>
        {criteria.map((c, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={`Criterion ${i + 1}`} value={c} onChange={(e) => setCriterion(i, e.target.value)} />
            <Button variant="ghost" size="sm" onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setCriteria((cs) => [...cs, ''])}>
          Add criterion
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            run(async () => {
              if (dirty) {
                const saved = await editDraftAction(itemId, content);
                if (saved.error) return saved;
              }
              return approveAction(itemId);
            })
          }
        >
          Approve → create in Linear
        </Button>
        <Button variant="outline" disabled={pending || !dirty} onClick={() => run(() => editDraftAction(itemId, content))}>
          Save edits
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="draft-feedback">Revise with feedback</Label>
        <Textarea
          id="draft-feedback"
          rows={2}
          placeholder="e.g. focus on the mobile case"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <Button variant="secondary" size="sm" disabled={pending || !feedback.trim()} onClick={() => run(() => reviseAction(itemId, feedback))}>
          Ask Claude to revise
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
```

`src/components/activity-list.tsx`:
```tsx
import type { Activity } from '@/core/db/schema';

export function ActivityList({ activity }: { activity: Activity[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Activity</h3>
      <ol className="space-y-1 text-sm">
        {activity.map((a) => (
          <li key={a.id} className="flex gap-3">
            <time className="shrink-0 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</time>
            <span>{a.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

`src/components/item-controls.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { discardAction, linkAction, moveAction, retryAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Category, Item } from '@/core/db/schema';
import { CATEGORY_LABELS } from '@/lib/format';

const CATEGORY_OPTIONS = Object.keys(CATEGORY_LABELS) as Category[];
import type { ItemActionFlags } from '@/lib/item-actions';
import { useActionRunner } from './use-action-runner';

export function ItemControls({ item, flags }: { item: Item; flags: ItemActionFlags }) {
  const [identifier, setIdentifier] = useState('');
  const { pending, error, run } = useActionRunner();
  return (
    <section className="space-y-3">
      {item.lastError && (
        <div className="flex items-center gap-3 rounded-md border border-destructive p-3 text-sm text-destructive">
          <span className="flex-1">{item.lastError}</span>
          {flags.canRetry && (
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => retryAction(item.id))}>
              Retry
            </Button>
          )}
        </div>
      )}
      {flags.canLink && (
        <div className="flex gap-2">
          <Input placeholder="Link existing issue, e.g. ENG-123" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          <Button variant="outline" disabled={pending || !identifier.trim()} onClick={() => run(() => linkAction(item.id, identifier))}>
            Link
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={item.category} onValueChange={(v) => run(() => moveAction(item.id, v as Category))}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_OPTIONS.map((c) => (
              <SelectItem key={c} value={c}>
                Move to {CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {flags.canDiscard && (
          <Button variant="ghost" disabled={pending} onClick={() => run(() => discardAction(item.id))}>
            Discard
          </Button>
        )}
        {flags.busy && <span className="text-sm text-muted-foreground">Working…</span>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
```

`src/components/item-sheet.tsx`:
```tsx
'use client';

import { useRouter } from 'next/navigation';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { ItemDetail } from '@/core/queries';
import { CATEGORY_LABELS, displayTitle, TRIAGE_STATE_LABELS } from '@/lib/format';
import { itemActionFlags } from '@/lib/item-actions';
import { ActivityList } from './activity-list';
import { DraftEditor } from './draft-editor';
import { DuplicatePanel } from './duplicate-panel';
import { ItemControls } from './item-controls';
import { ThreadPreview } from './thread-preview';

export function ItemSheet({ detail, closeHref }: { detail: ItemDetail; closeHref: string }) {
  const router = useRouter();
  const { item } = detail;
  const flags = itemActionFlags(item, detail.activeJob);
  return (
    <Sheet open onOpenChange={(open) => !open && router.push(closeHref, { scroll: false })}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{displayTitle(item)}</SheetTitle>
          <SheetDescription>
            #{item.id} · {CATEGORY_LABELS[item.category]}
            {item.triageState && ` · ${TRIAGE_STATE_LABELS[item.triageState]}`}
            {item.linearUrl && (
              <>
                {' · '}
                <a className="underline-offset-4 hover:underline" href={item.linearUrl} target="_blank" rel="noreferrer">
                  {item.linearIdentifier}
                </a>
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          <ItemControls item={item} flags={flags} />
          <ThreadPreview item={item} />
          <DuplicatePanel itemId={item.id} candidates={detail.candidates} enabled={flags.canResolveDuplicate} />
          <DraftEditor itemId={item.id} drafts={detail.drafts} editable={flags.canEditDraft} />
          <Separator />
          <ActivityList activity={detail.activity} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

`ItemSheet` imports the type `ItemDetail` from `@/core/queries` with `import type`, so nothing from queries ends up in the client bundle.

- [ ] **Step 6: Render the sheet from `src/app/page.tsx`**

Add these imports:
```tsx
import { ItemSheet } from '@/components/item-sheet';
import { getItemDetail, getQueueStatus, listItems } from '@/core/queries';
```
(replacing the existing `@/core/queries` import). Inside `Page`, before `return`, add:
```tsx
  const itemId = Number(params.item);
  const detail = Number.isInteger(itemId) && itemId > 0 ? getItemDetail(db, itemId) : null;
  const closeHref = showDismissed ? '/?dismissed=1' : '/';
```
and render the sheet as the last child of the outer `<div>`:
```tsx
      {detail && <ItemSheet detail={detail} closeHref={closeHref} />}
```

- [ ] **Step 7: Run tests, typecheck and build**

Run: `npx vitest run src && npx tsc --noEmit && npm run build`
Expected: tests PASS; tsc clean; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/app src/components src/lib
git commit -m "feat: add item sheet with duplicate panel, draft editor and actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Demo seed, UI verification and README

Use the `webapp-testing` skill (example-skills) for the browser checks.

**Files:**
- Create: `scripts/seed-demo.ts`
- Modify: `README.md`, `CLAUDE.md` (the "No application code exists yet" line)

**Interfaces:**
- Consumes: repositories and actions from core.
- Produces: `npm run seed:demo`, which fills the DB at `WORKFLOW_DB` with one item in each interesting state.

- [ ] **Step 1: Write `scripts/seed-demo.ts`**

```ts
import { recordPollError, recordPollSuccess } from '@/core/cursors';
import { defaultDbPath, openDb } from '@/core/db/client';
import { items } from '@/core/db/schema';
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

insert({
  title: 'Invoice PDF missing VAT number',
  triageState: 'failed',
  failedFromState: 'new',
  lastError: 'Slack API error: channel_not_found',
  slackChannel: 'C_DEMO',
  slackThreadTs: '3.0',
});
upsertLinearItem(db, { id: 'demo-2', identifier: 'ENG-52', title: 'Room capacity filter ignores accessibility', url: 'https://linear.app' }, 'in_progress', now);
upsertLinearItem(db, { id: 'demo-3', identifier: 'ENG-60', title: 'Search times out on long queries', url: 'https://linear.app' }, 'done', now);

recordPollSuccess(db, 'slack', 'initialized', now - 30_000);
recordPollSuccess(db, 'config', null, now - 30_000);
recordPollError(db, 'linear', 'Linear server error 502', now - 20_000);
console.log(`Seeded demo data into ${defaultDbPath()}`);
```

- [ ] **Step 2: Seed a demo DB and start the web app against it**

Run:
```bash
rm -f data/demo.db data/demo.db-wal data/demo.db-shm
WORKFLOW_DB=data/demo.db npm run seed:demo
WORKFLOW_DB=data/demo.db npm run dev:web
```
(The second command runs in the background. Don't start the worker: the demo uses fake Linear IDs.)
Expected: `Seeded demo data into …/data/demo.db`; Next.js serves http://127.0.0.1:3000.

- [ ] **Step 3: Verify the UI with the webapp-testing skill**

Using Playwright through the `webapp-testing` skill, check each of the following. Take screenshots and fix any failure before moving on:
1. The board shows four columns: Triage (3 items), In Progress (1), Verification (0), Done (1). The header shows `linear: error` in red, plus `slack: ok … ago` and `0 queued`.
2. Clicking "CSV export returns 500…" opens the sheet. It shows the two-message Slack thread preview, the draft fields filled in, the version picker at `v1 by claude`, and the Approve, Save edits and Revise controls.
3. Change the title and click **Save edits**. After the refresh the version picker shows `v2 by user`.
4. Click **Approve → create in Linear**. The sheet now shows `creating issue` and "Working…", and the Approve button is gone. The card badge reads `creating issue`.
5. Open "Calendar sync shows events twice". It shows ENG-41 at 88% with its reasoning, a "Link to ENG-41" button and a "Not a duplicate" button. Click **Link to ENG-41**: the duplicate buttons disappear (a job is queued).
6. Open "Invoice PDF missing VAT number". It shows the red error box with **Retry**. Click Retry: the badge changes to `queued`.
7. Click **Discard** on any item. It leaves the board, and "Show dismissed" lists it.
8. Pressing Escape closes the sheet and the URL goes back to `/`.
9. The browser console has no errors.

Stop the dev server afterwards.

- [ ] **Step 4: Update `README.md`**

```markdown
# workflow

A personal task queue fed by Slack reactions and Linear changes, with a Claude-assisted 👀 triage flow and a local dashboard.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in `SLACK_USER_TOKEN` (a user token, `xoxp-…`) and `LINEAR_API_KEY`.
3. Set `linear.defaultTeam` in `workflow.config.yaml`.
4. `npm run smoke` checks the Slack, Linear and Claude credentials.

## Run

- `npm run dev` starts the dashboard on http://127.0.0.1:3000 and the worker (pollers + jobs).
- `npm run queue -- list` / `show <id>` / `approve <id>` / `link <id> ENG-123` / `revise <id> "feedback"` / `move <id> <category>` / `discard <id>` / `retry <id>`. Add `--json` to `list` and `show` for machine-readable output.

On its first run the Slack poller records your existing reactions without queueing them. Only reactions added afterwards trigger rules. Set `slack.backfillOnFirstRun: true` to change this.

## Config

`workflow.config.yaml` maps events to categories. The first matching rule wins. The worker re-reads the file every poll cycle. If an edit makes it invalid, the worker keeps the last valid version and the header shows `config: error`.

## Tests

`npm test` (no network). `npm run typecheck`.

## Design

- Spec: `docs/superpowers/specs/2026-10-10-queue-triage-design.md`
- Plan: `docs/superpowers/plans/2026-10-10-queue-triage.md`
```

In `CLAUDE.md`, replace the line `No application code exists yet.` with:
```
Sub-projects 1–3 (queue core, ingestion, 👀 triage) are implemented; see README.md for commands. Next: investigation/implementation workers (sub-project 4).
```

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-demo.ts README.md CLAUDE.md package.json
git commit -m "docs: add demo seed, README and verify dashboard flows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
