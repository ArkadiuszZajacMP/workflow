# Investigation and Implementation Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a queue item with a Linear issue go through Claude investigation, then a plan you review, a posted Linear comment, one draft PR per planned breakdown entry built inside a per-item Podman container, PR status tracking with an on-demand **Fix with Claude**, and finally the move to Verification.

**Architecture:** A new `work_state` lifecycle runs next to the existing triage lifecycle, with new tables for plans, planned PRs, workspaces and agent runs. Long Claude runs go through a separate **agent lane** in the worker. It drives `claude -p` inside per-item Podman containers through a `ContainerEngine` interface, and secrets (Claude token, GitHub token, short-lived CodeArtifact token) are passed per exec as `--env NAME` only. A host-side GitHub client verifies PRs, polls their CI and review status, and feeds fix rounds. The dashboard and CLI gain the matching actions and panels.

**Tech Stack:** Node 24, TypeScript, Drizzle + better-sqlite3, zod 4, Vitest, Next.js 16 (App Router, webpack), shadcn/ui (Base UI), commander, Podman 5 (rootless), Claude Code CLI (`claude -p --output-format stream-json`), GitHub GraphQL/REST over `fetch`, Linear GraphQL, AWS CLI (CodeArtifact token only).

**Spec:** `docs/superpowers/specs/2026-10-15-agent-workers-design.md` (it builds on `docs/superpowers/specs/2026-10-10-queue-triage-design.md`)

## Global Constraints

- Package manager: **npm**. Scripts go through `npm run …`. The worker and `smoke` get secrets from 1Password via `bash scripts/with-secrets.sh` (it resolves `op://` references in the gitignored `.env.op`). Never write secret values to disk or to git.
- Secrets are passed into containers **only** as `podman exec --env NAME`, with the value in the child-process environment, never as `NAME=value` arguments. Investigation runs never receive `GH_TOKEN` or `CODEARTIFACT_AUTH_TOKEN`.
- No AWS credentials ever enter a container. Only the short-lived CodeArtifact token does, and only for install-capable runs.
- The web app and the CLI never call Slack, Linear, GitHub, Claude, Podman or AWS. Only `src/worker/**` and `scripts/smoke.ts` construct real clients or engines. Reading the local repo map file (`~/.claude/skills/meetingpackage/config/repositories.json`) is allowed in web and CLI.
- Client components (`'use client'`) may only `import type` from `@/core/**`.
- Claude in containers is invoked as `claude -p <prompt> --output-format stream-json --verbose --max-turns N`. Investigation uses `--allowedTools "Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git diff:*),Bash(ls:*)"`. Implement and fix runs use `--dangerously-skip-permissions`, which is acceptable only inside the container.
- Branches are named `{team}-{number}-{slug}`, all lowercase (e.g. `boo-1430-add-webhook-parser`). PRs are opened as **drafts**. No AI co-author trailers, no AI branding, no AI accounts as assignees or reviewers (per the user's `github` skill).
- Container user: the image's `node` user (uid 1000), `HOME=/home/node`, workspace volume at `/work`, repos at `/work/<repo_key>`.
- Workspace names: container and volume `wf-<identifier-lowercase>`, e.g. `wf-boo-1430`.
- Plan comment format: `## Implementation plan\n\n<body>\n\n### PR breakdown\n1. \`repo\` — scope\n…`.
- Timestamps are epoch ms integers. All writes from actions and handlers use `writeTransaction` (BEGIN IMMEDIATE).
- Tests are colocated as `src/**/*.test.ts`. `npm test` makes no network calls and never runs Podman. Podman tests are `src/**/*.podman.test.ts` and run only through `npm run test:podman`.
- Commit messages: conventional (`feat: …`, `fix: …`, `docs: …`). Each ends with the committing model's own trailer line `Co-Authored-By: <your model name> <noreply@anthropic.com>`, passed as a second `-m`.

### Intentional differences from the spec

Report these when you finish.

1. **No separate `prepare-workspace` job.** `investigate`, `implement-pr` and `fix-pr` all call the idempotent `ensureWorkspace(deps, item, repoKeys)` first. This removes ordering problems between jobs. The agent job types are `investigate`, `implement-pr`, `fix-pr` and `remove-workspace`.
2. **Container user.** The container user is the image's built-in `node` (uid 1000, `HOME=/home/node`), not a new `agent` user.
3. **Env files.** They come from where the `docker` skill's `sync-env.sh` writes them (`<dockerSkillDir>/private/env/<repo>/<env>`) and are copied in with `podman cp`. The worker never reads them and doesn't delete them, because that directory belongs to the docker skill.
4. **CodeArtifact profile.**
   - If the repo has its own `awsProfile`, that profile is used and token failures are permanent errors.
   - Otherwise, node-type repos use `defaults.awsProfile`, and a token failure there only logs a warning and installs without a token.
5. **Shutdown.** Stopping the worker doesn't abort in-flight agent runs. Crash recovery requeues them on the next start, and `implement-pr`'s branch check prevents duplicate PRs.
6. **Agent features are optional.** The agent lane and the GitHub poller start only when `GITHUB_TOKEN`, `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` all resolve. Otherwise the header shows `github: error — agent workers not configured …` and triage keeps working.

## Review Focus

1. **The worker restarts (or `node --watch` reloads) in the middle of `implement-pr`.** The requeued job must find the already-open PR for the branch and mark it open, not open a second PR. Test: Task 13.
2. **Claude ends with prose or malformed JSON.** The run is resumed once with the validation error. A second failure is a permanent failure with a readable message. Test: Task 10.
3. **Stop run during a long run.** The exec is killed, the run is recorded as `stopped`, the job fails permanently, and the item can be retried. Test: Task 10.
4. **The repo map file is missing or invalid.** Actions return a readable error, the dashboard shows an empty repo list instead of crashing, and agent jobs fail permanently with the path. Test: Tasks 2 and 4.
5. **Secrets never appear in process arguments, and investigation never gets push or registry tokens.** Test: Tasks 5 and 11.
6. **An expired AWS SSO session.** The job fails with "Try: aws sso login --profile …". Test: Task 8.

---

## File map

```
containers/agent/Containerfile                         agent image (Node 24, git, gh, jq, mise, claude CLI)
prompts/agent-investigate.md, agent-implement.md, agent-fix.md
vitest.config.ts (modify: exclude *.podman.test.ts), vitest.podman.config.ts
.env.op.example (modify), package.json (modify), README.md (modify), scripts/smoke.ts (modify), scripts/seed-demo.ts (modify)
src/core/
  paths.ts                     expandHome
  db/schema.ts (modify)        work_state, plans, planned_prs, workspaces, agent_runs, stop_requested
  config/schema.ts (modify)    agent section, start-investigation rule action
  cursors.ts (modify)          'github' poll source
  repos/map.ts                 repo map parsing, validateBreakdown
  repos/current.ts             loadCurrentRepoMap / knownRepoKeys (web + CLI)
  work/machine.ts              pure work-state transitions
  work/state.ts                applyWorkEvent, markWorkFailed
  work/plans.ts                plan versions + comment rendering
  work/planned-prs.ts          planned PR rows, branch names, rollup
  work/workspaces.ts           workspace rows
  work/runs.ts                 agent_runs rows
  work/stream.ts               stream-json parsing for results and log tails
  work/gc.ts                   enqueue workspace removal for old done/dismissed items
  jobs/queue.ts (modify)       new payloads, typed claims, failure routing, stop flag
  jobs/rearm.ts (modify)       re-arm work jobs
  ingest.ts (modify)           start-investigation rule action
  rules/match.ts (modify)      RuleAction type
  actions/work.ts              startInvestigation, editPlan, revisePlan, approvePlan, retryWork, fixPr, stopRun, removeWorkspace
  actions/index.ts (modify)
  clients/types.ts (modify)    GitHubClient + Linear additions
  clients/github.ts            GitHub client
  clients/linear.ts (modify)   comments, issue details, state update
  queries.ts (modify)          detail + rollups
src/worker/
  execute.ts                   shared job bookkeeping (core + agent lanes)
  runner.ts (modify)           core lane: core job types only, post-plan handler, github poller, gc
  main.ts (modify)             agent lane wiring
  handlers/types.ts (modify)   optional repoMap in HandlerContext
  handlers/post-plan.ts
  pollers/github.ts
  agent/process.ts             runProcess (spawn, lines, timeout, abort)
  agent/engine.ts              ContainerEngine, PodmanEngine, execArgs
  agent/codeartifact.ts        token cache + registry auth wrapper
  agent/host.ts                git identity, sync-env, detect-repository
  agent/deps.ts                AgentDeps, AgentHandler
  agent/workspace.ts           ensureWorkspace, registryAuth, removeWorkspaceHandler
  agent/prompts.ts             renderAgentPrompt
  agent/run.ts                 claudeArgs, runAgent
  agent/handlers/investigate.ts, implement-pr.ts, fix-pr.ts
  agent/lane.ts                AgentLane
src/cli/program.ts (modify)
src/app/actions.ts (modify), src/app/page.tsx (modify), src/app/runs/[id]/route.ts
src/components/ work-panel.tsx, plan-editor.tsx, prs-panel.tsx, run-panel.tsx (new); item-sheet.tsx, item-card.tsx, board.tsx, status-header.tsx (modify)
src/lib/ format.ts (modify), work-flags.ts (new)
src/test/ fakes.ts (modify), fake-engine.ts, repo-map.ts, agent.ts (new)
```

---

### Task 1: Schema, migration, config and poll source

**Files:**
- Modify: `src/core/db/schema.ts`, `src/core/config/schema.ts`, `src/core/rules/match.ts`, `src/core/cursors.ts`, `workflow.config.yaml`
- Create: `src/core/paths.ts`, migration `src/core/db/migrations/0001_agent_workers.sql` (generated)
- Test: `src/core/db/client.test.ts`, `src/core/config/load.test.ts`, `src/core/paths.test.ts`

**Interfaces:**
- Produces:
  - **schema.ts:**
    - constants and types: `WORK_STATES` / `WorkState`, `AGENT_JOB_TYPES` / `AgentJobType`, `CORE_JOB_TYPES: JobType[]`, `PLANNED_PR_STATES` / `PlannedPrState`, `CI_STATES` / `CiState`, `WORKSPACE_STATUSES` / `WorkspaceStatus`, `AGENT_RUN_KINDS` / `AgentRunKind`, `RUN_OUTCOMES` / `RunOutcome`, `BreakdownEntry = { repo: string; scope: string }`
    - tables: `plans`, `plannedPrs`, `workspaces`, `agentRuns`
    - row types: `Plan`, `PlannedPr`, `Workspace`, `AgentRun`
    - new item columns: `workState`, `workFailedFromState`, `planCommentId`
    - new job column: `stopRequested` (boolean)
    - `JOB_TYPES` extended with `investigate`, `post-plan`, `implement-pr`, `fix-pr`, `remove-workspace`
  - **config:** `Config['agent']` (type `AgentConfig`), `RULE_ACTIONS`, `RuleAction = 'triage-draft' | 'start-investigation'`
  - **rules/match.ts:** `RuleMatch = { category: RuleCategory; action?: RuleAction }`
  - **cursors.ts:** `PollSource` gains `'github'`
  - **paths.ts:** `expandHome(p: string): string`

- [ ] **Step 1: Write the failing tests**

In `src/core/db/client.test.ts`, replace the expected table list in `creates all tables and enables WAL` with:
```ts
    expect(tables).toEqual([
      'activity',
      'agent_runs',
      'drafts',
      'duplicate_candidates',
      'items',
      'jobs',
      'linear_issue_snapshots',
      'planned_prs',
      'plans',
      'poll_cursors',
      'source_events',
      'workspaces',
    ]);
```

Then add to the same file:
```ts
import { enqueueJob } from '@/core/jobs/queue';

describe('agent worker columns', () => {
  it('defaults work_state to null and stop_requested to false', () => {
    const db = createTestDb();
    const item = seedItem(db);
    expect(item.workState).toBeNull();
    const job = enqueueJob(db, 'draft', item.id, {}, 1);
    expect(job.stopRequested).toBe(false);
  });
});
```

In `src/core/config/load.test.ts`, replace the expected config in `applies defaults to a minimal config` with:
```ts
      config: {
        linear: { defaultTeam: 'ENG' },
        slack: { pollIntervalSeconds: 60, backfillOnFirstRun: false },
        claude: { model: null },
        triage: { duplicateThreshold: 0.7, searchClosedWithinDays: 90, maxCandidates: 15 },
        agent: {
          containerEngine: 'podman',
          image: 'workflow-agent:latest',
          maxConcurrent: 1,
          timeoutMinutes: { investigate: 20, implement: 60 },
          maxTurns: { investigate: 60, implement: 200 },
          prPollSeconds: 120,
          workspaceRetentionDays: 7,
          meetingpackageSkillDir: '~/.claude/skills/meetingpackage',
          dockerSkillDir: '~/.claude/skills/docker',
          githubSkillDir: '~/.claude/skills/github',
          syncEnv: true,
          envName: 'development',
          defaultRepos: [],
          linearStatusOnImplement: null,
        },
        rules: [],
      },
```
and add these cases inside `describe('parseConfig', …)`:
```ts
  it('allows start-investigation on linear rules only', () => {
    const ok = `${minimal}rules:\n  - when: { source: linear, label: ready-to-investigate }\n    category: triage\n    action: start-investigation\n`;
    expect(parseConfig(ok).ok).toBe(true);
    const bad = `${minimal}rules:\n  - when: { source: slack, reaction: eyes }\n    category: triage\n    action: start-investigation\n`;
    expect(parseConfig(bad)).toMatchObject({ ok: false, error: expect.stringContaining('only allowed on linear rules') });
  });

  it('rejects an unknown container engine setting type', () => {
    expect(parseConfig(`${minimal}agent:\n  maxConcurrent: 0\n`).ok).toBe(false);
  });
```

Create `src/core/paths.test.ts`:
```ts
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from './paths';

describe('expandHome', () => {
  it('expands a leading ~ and leaves other paths alone', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.claude/skills')).toBe(path.join(homedir(), '.claude/skills'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('rel/~/x')).toBe('rel/~/x');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/db src/core/config src/core/paths.test.ts`
Expected: FAIL. The table list is missing the new tables, `agent` is not in the config, and `./paths` can't be resolved.

- [ ] **Step 3: Extend `src/core/db/schema.ts`**

Replace the `JOB_TYPES` block with:
```ts
export const JOB_TYPES = [
  'triage-draft',
  'draft',
  'create-linear-issue',
  'link-linear-issue',
  'investigate',
  'post-plan',
  'implement-pr',
  'fix-pr',
  'remove-workspace',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Long Claude/container jobs. They run in the worker's agent lane, never in the core lane. */
export const AGENT_JOB_TYPES = ['investigate', 'implement-pr', 'fix-pr', 'remove-workspace'] as const satisfies readonly JobType[];
export type AgentJobType = (typeof AGENT_JOB_TYPES)[number];
export const CORE_JOB_TYPES: JobType[] = JOB_TYPES.filter((t) => !(AGENT_JOB_TYPES as readonly string[]).includes(t));

export const WORK_STATES = ['investigating', 'plan_ready', 'posting_plan', 'implementing', 'prs_open', 'failed'] as const;
export type WorkState = (typeof WORK_STATES)[number];
```

In the `items` table, add after `lastError`:
```ts
    workState: text('work_state', { enum: WORK_STATES }),
    workFailedFromState: text('work_failed_from_state', { enum: WORK_STATES }),
    planCommentId: text('plan_comment_id'),
```

In the `jobs` table, add after `lastError`:
```ts
    stopRequested: integer('stop_requested', { mode: 'boolean' }).notNull().default(false),
```

Append before the `export type Item …` lines:
```ts
export type BreakdownEntry = { repo: string; scope: string };

export const plans = sqliteTable(
  'plans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    breakdown: text('breakdown', { mode: 'json' }).$type<BreakdownEntry[]>().notNull(),
    author: text('author', { enum: ['claude', 'user'] }).notNull(),
    feedback: text('feedback'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('plans_item_version_idx').on(t.itemId, t.version)],
);

export const PLANNED_PR_STATES = ['pending', 'implementing', 'open', 'failed'] as const;
export type PlannedPrState = (typeof PLANNED_PR_STATES)[number];
export const CI_STATES = ['none', 'pending', 'success', 'failure'] as const;
export type CiState = (typeof CI_STATES)[number];

export const plannedPrs = sqliteTable(
  'planned_prs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    planVersion: integer('plan_version').notNull(),
    position: integer('position').notNull(),
    repoKey: text('repo_key').notNull(),
    githubRepo: text('github_repo').notNull(),
    scope: text('scope').notNull(),
    branch: text('branch').notNull(),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    state: text('state', { enum: PLANNED_PR_STATES }).notNull().default('pending'),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    merged: integer('merged', { mode: 'boolean' }).notNull().default(false),
    unresolvedThreads: integer('unresolved_threads').notNull().default(0),
    ciState: text('ci_state', { enum: CI_STATES }).notNull().default('none'),
    polledAt: integer('polled_at'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('planned_prs_item_position_idx').on(t.itemId, t.position)],
);

export const WORKSPACE_STATUSES = ['creating', 'ready', 'broken', 'removed'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const workspaces = sqliteTable('workspaces', {
  itemId: integer('item_id')
    .primaryKey()
    .references(() => items.id),
  container: text('container').notNull(),
  volume: text('volume').notNull(),
  image: text('image').notNull(),
  status: text('status', { enum: WORKSPACE_STATUSES }).notNull(),
  repos: text('repos', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
});

export const AGENT_RUN_KINDS = ['investigate', 'implement-pr', 'fix-pr'] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];
export const RUN_OUTCOMES = ['running', 'succeeded', 'failed', 'timed_out', 'stopped'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id),
  itemId: integer('item_id')
    .notNull()
    .references(() => items.id),
  plannedPrId: integer('planned_pr_id').references(() => plannedPrs.id),
  kind: text('kind', { enum: AGENT_RUN_KINDS }).notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  outcome: text('outcome', { enum: RUN_OUTCOMES }).notNull(),
  summary: text('summary'),
  logPath: text('log_path').notNull(),
});
```
and append after the existing row types:
```ts
export type Plan = typeof plans.$inferSelect;
export type PlannedPr = typeof plannedPrs.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -- --name agent_workers`
Expected: `src/core/db/migrations/0001_agent_workers.sql` with `ALTER TABLE items ADD …` (three columns), `ALTER TABLE jobs ADD stop_requested`, and `CREATE TABLE` for `plans`, `planned_prs`, `workspaces` and `agent_runs`. Open the SQL. If drizzle-kit chose to rebuild `items` or `jobs` (a `__new_` table copy) instead of `ALTER TABLE … ADD`, that is still correct; keep it.

- [ ] **Step 5: Implement `src/core/paths.ts`**

```ts
import { homedir } from 'node:os';
import path from 'node:path';

/** Expands a leading `~` (as in `~/.claude/skills/...` config values) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}
```

- [ ] **Step 6: Extend `src/core/config/schema.ts`**

Replace the `ruleSchema` and `configSchema` definitions with:
```ts
export const RULE_ACTIONS = ['triage-draft', 'start-investigation'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const ruleSchema = z
  .strictObject({
    when: z.union([slackWhen, linearStatusWhen, linearLabelWhen]),
    category: z.enum(RULE_CATEGORIES),
    action: z.enum(RULE_ACTIONS).optional(),
  })
  .refine((rule) => rule.action !== 'triage-draft' || rule.when.source === 'slack', {
    message: 'action "triage-draft" is only allowed on slack rules',
  })
  .refine((rule) => rule.action !== 'start-investigation' || rule.when.source === 'linear', {
    message: 'action "start-investigation" is only allowed on linear rules',
  });

const agentSchema = z.strictObject({
  containerEngine: z.string().min(1).default('podman'),
  image: z.string().min(1).default('workflow-agent:latest'),
  maxConcurrent: z.number().int().min(1).max(4).default(1),
  timeoutMinutes: z
    .strictObject({
      investigate: z.number().int().min(1).default(20),
      implement: z.number().int().min(1).default(60),
    })
    .prefault({}),
  maxTurns: z
    .strictObject({
      investigate: z.number().int().min(1).default(60),
      implement: z.number().int().min(1).default(200),
    })
    .prefault({}),
  prPollSeconds: z.number().int().min(30).default(120),
  workspaceRetentionDays: z.number().int().min(0).default(7),
  meetingpackageSkillDir: z.string().min(1).default('~/.claude/skills/meetingpackage'),
  dockerSkillDir: z.string().min(1).default('~/.claude/skills/docker'),
  githubSkillDir: z.string().min(1).default('~/.claude/skills/github'),
  syncEnv: z.boolean().default(true),
  envName: z.enum(['development', 'staging']).default('development'),
  defaultRepos: z.array(z.string().min(1)).default([]),
  linearStatusOnImplement: z.string().min(1).nullable().default(null),
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
  agent: agentSchema.prefault({}),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
export type AgentConfig = Config['agent'];
export type Rule = z.infer<typeof ruleSchema>;
```

- [ ] **Step 7: Update `src/core/rules/match.ts` and `src/core/cursors.ts`**

In `match.ts`, change the imports and the type:
```ts
import type { Rule, RuleAction, RuleCategory } from '../config/schema';
import type { SourceEvent } from '../events';

export type RuleMatch = { category: RuleCategory; action?: RuleAction };
```

In `cursors.ts`:
```ts
export type PollSource = 'slack' | 'linear' | 'config' | 'github';
```

- [ ] **Step 8: Document the new config in `workflow.config.yaml`**

Add above `rules:` (the defaults are already applied by the schema; this documents them):
```yaml
agent:
  containerEngine: podman
  maxConcurrent: 1
  prPollSeconds: 120
  workspaceRetentionDays: 7
  defaultRepos: []
  linearStatusOnImplement: null
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS (the existing suite plus the new cases); tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/core/db src/core/config src/core/rules/match.ts src/core/cursors.ts src/core/paths.ts src/core/paths.test.ts workflow.config.yaml
git commit -m "feat: add agent worker schema, config and rule action" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 2: Work state machine, repo map, plans and planned PRs

**Files:**
- Create: `src/core/work/machine.ts`, `src/core/work/state.ts`, `src/core/repos/map.ts`, `src/core/work/plans.ts`, `src/core/work/planned-prs.ts`, `src/test/repo-map.ts`
- Test: `src/core/work/machine.test.ts`, `src/core/work/state.test.ts`, `src/core/repos/map.test.ts`, `src/core/work/plans.test.ts`, `src/core/work/planned-prs.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; `requireItem`, `getItem`, `updateItem`, `logActivity` (`src/core/items.ts`); `ActionError`, `PermanentError`, `errorMessage` (`src/core/errors.ts`).
- Produces:
  - `machine.ts`:
    - `type WorkEvent = { type: 'start' } | { type: 'plan_saved' } | { type: 'user_edited' } | { type: 'revise_requested' } | { type: 'approved' } | { type: 'plan_posted' } | { type: 'all_prs_open' } | { type: 'job_failed' } | { type: 'retry'; to: WorkState }`
    - `transitionWork(state: WorkState | null, event: WorkEvent): { ok: true; state: WorkState } | { ok: false; error: string }`
  - `state.ts`:
    - `applyWorkEvent(db, itemId, event, now?): Item` (throws `ActionError`)
    - `markWorkFailed(db, itemId, fromState: WorkState | null, message, now?): void`
  - `repos/map.ts`:
    - `RepoEntry` (`key, repo, url, defaultBranch, type, node?, packageManager?, installCommand, awsProfile?, validationCommands, envTargets, aliases`)
    - `RepoDefaults` (`awsRegion, awsAccountId, codeArtifactDomain, codeArtifactRegistry, awsProfile?`)
    - `RepoMap = { defaults; repos }`
    - `parseRepoMap(raw: unknown): RepoMap`, `loadRepoMap(skillDir: string): RepoMap`, `findRepo(map, key): RepoEntry | undefined`, `validateBreakdown(breakdown: BreakdownEntry[], map): string | null`
  - `plans.ts`:
    - `PlanContent = { body: string; breakdown: BreakdownEntry[] }`
    - `latestPlan(db, itemId): Plan | undefined`, `listPlans(db, itemId): Plan[]`
    - `savePlan(db, itemId, content, author: 'claude' | 'user', feedback: string | null, now?): Plan`
    - `cleanPlanContent(content): PlanContent`, `renderPlanComment(content: PlanContent): string`
  - `planned-prs.ts`:
    - `branchName(identifier, scope): string`
    - `createPlannedPrs(db, item: Item, plan: Plan, map: RepoMap, now?): PlannedPr[]`
    - `listPlannedPrs(db, itemId): PlannedPr[]`, `getPlannedPr(db, id): PlannedPr | undefined`
    - `updatePlannedPr(db, id, patch: PlannedPrPatch, now?): PlannedPr`
    - `nextPendingPr(db, itemId): PlannedPr | undefined`, `firstUnfinishedPr(db, itemId): PlannedPr | undefined`, `allPrsOpen(db, itemId): boolean`
    - `PrRollup = { planned: number; opened: number; ci: CiState; unresolved: number }`, `prRollup(prs): PrRollup`
  - `src/test/repo-map.ts`: `TEST_REPO_MAP: RepoMap` with repos `core` (awsProfile `core-artifactory`), `web` (no awsProfile) and `infra` (terraform).

- [ ] **Step 1: Create the shared test fixture `src/test/repo-map.ts`**

```ts
import type { RepoMap } from '@/core/repos/map';

export const TEST_REPO_MAP: RepoMap = {
  defaults: {
    awsRegion: 'eu-west-2',
    awsAccountId: '111122223333',
    codeArtifactDomain: 'acme-npm',
    codeArtifactRegistry: 'https://acme-npm-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/acme-internal/',
    awsProfile: 'Acme-Artifactory',
  },
  repos: [
    {
      key: 'core',
      repo: 'acme/core',
      url: 'https://github.com/acme/core.git',
      defaultBranch: 'main',
      type: 'node',
      node: '24.16.0',
      packageManager: 'yarn',
      installCommand: 'yarn install',
      awsProfile: 'core-artifactory',
      validationCommands: ['yarn lint:quiet'],
      envTargets: [{ document: '{environment}-core-dotenv', path: 'apps/core/.env' }],
      aliases: ['core-api'],
    },
    {
      key: 'web',
      repo: 'acme/web',
      url: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
      type: 'node',
      node: '22',
      packageManager: 'npm',
      installCommand: 'npm install',
      validationCommands: ['npm run lint', 'npm test'],
      envTargets: [],
      aliases: [],
    },
    {
      key: 'infra',
      repo: 'acme/infra',
      url: 'https://github.com/acme/infra.git',
      defaultBranch: 'main',
      type: 'terraform',
      installCommand: '',
      validationCommands: ['terraform fmt -check -recursive'],
      envTargets: [],
      aliases: [],
    },
  ],
};
```

- [ ] **Step 2: Write the failing tests**

`src/core/work/machine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { WorkState } from '@/core/db/schema';
import { type WorkEvent, transitionWork } from './machine';

describe('transitionWork', () => {
  it.each<[WorkState | null, WorkEvent, WorkState]>([
    [null, { type: 'start' }, 'investigating'],
    ['investigating', { type: 'plan_saved' }, 'plan_ready'],
    ['plan_ready', { type: 'user_edited' }, 'plan_ready'],
    ['plan_ready', { type: 'revise_requested' }, 'investigating'],
    ['plan_ready', { type: 'approved' }, 'posting_plan'],
    ['posting_plan', { type: 'plan_posted' }, 'implementing'],
    ['implementing', { type: 'all_prs_open' }, 'prs_open'],
    ['investigating', { type: 'job_failed' }, 'failed'],
    ['posting_plan', { type: 'job_failed' }, 'failed'],
    ['implementing', { type: 'job_failed' }, 'failed'],
    ['failed', { type: 'retry', to: 'implementing' }, 'implementing'],
  ])('%s + %o → %s', (from, event, to) => {
    expect(transitionWork(from, event)).toEqual({ ok: true, state: to });
  });

  it('rejects starting twice and approving while investigating', () => {
    expect(transitionWork('investigating', { type: 'start' }).ok).toBe(false);
    expect(transitionWork('investigating', { type: 'approved' })).toEqual({
      ok: false,
      error: 'Cannot approve the plan while work is investigating',
    });
  });

  it('only retries failed work, and never into failed, prs_open or plan_ready', () => {
    expect(transitionWork('plan_ready', { type: 'retry', to: 'investigating' }).ok).toBe(false);
    expect(transitionWork('failed', { type: 'retry', to: 'failed' }).ok).toBe(false);
    expect(transitionWork('failed', { type: 'retry', to: 'prs_open' }).ok).toBe(false);
  });

  it('does not fail work that is plan_ready or prs_open', () => {
    expect(transitionWork('plan_ready', { type: 'job_failed' }).ok).toBe(false);
    expect(transitionWork('prs_open', { type: 'job_failed' }).ok).toBe(false);
  });
});
```

`src/core/work/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ActionError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { applyWorkEvent, markWorkFailed } from './state';

describe('work state helpers', () => {
  it('applies valid events and clears lastError', () => {
    const db = createTestDb();
    const item = seedItem(db, { lastError: 'old' });
    expect(applyWorkEvent(db, item.id, { type: 'start' }, 5)).toMatchObject({ workState: 'investigating', lastError: null });
    expect(() => applyWorkEvent(db, item.id, { type: 'start' }, 6)).toThrow(ActionError);
  });

  it('fails work and remembers where to resume', () => {
    const db = createTestDb();
    const item = seedItem(db, { workState: 'implementing' });
    markWorkFailed(db, item.id, 'implementing', 'GitHub authentication failed', 9);
    expect(getItem(db, item.id)).toMatchObject({
      workState: 'failed',
      workFailedFromState: 'implementing',
      lastError: 'GitHub authentication failed',
    });
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Failed: GitHub authentication failed');
  });

  it('only records the error when the work cannot fail', () => {
    const db = createTestDb();
    const item = seedItem(db, { workState: 'prs_open' });
    markWorkFailed(db, item.id, 'prs_open', 'boom', 9);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', lastError: 'boom' });
  });
});
```

`src/core/repos/map.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { findRepo, loadRepoMap, parseRepoMap, validateBreakdown } from './map';

const raw = {
  defaults: TEST_REPO_MAP.defaults,
  staging: { ignored: true },
  repositories: [
    { key: 'core', repo: 'acme/core', url: 'https://github.com/acme/core.git', installCommand: 'yarn install', extra: 1 },
  ],
};

describe('repo map', () => {
  it('parses the skill file shape and fills defaults', () => {
    const map = parseRepoMap(raw);
    expect(map.repos[0]).toMatchObject({
      key: 'core',
      defaultBranch: 'main',
      type: 'node',
      validationCommands: [],
      envTargets: [],
      aliases: [],
    });
    expect(findRepo(map, 'core')?.repo).toBe('acme/core');
    expect(findRepo(map, 'nope')).toBeUndefined();
  });

  it('loads from <skillDir>/config/repositories.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mp-skill-'));
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'repositories.json'), JSON.stringify(raw));
    expect(loadRepoMap(dir).repos).toHaveLength(1);
  });

  it('fails permanently with the path when the file is missing or invalid', () => {
    expect(() => loadRepoMap('/nonexistent/skill')).toThrow(PermanentError);
    expect(() => loadRepoMap('/nonexistent/skill')).toThrow(/\/nonexistent\/skill\/config\/repositories\.json/);
    expect(() => parseRepoMap({ repositories: 'x' })).toThrow(/Invalid repository map/);
  });

  it('validates a breakdown against the map', () => {
    expect(validateBreakdown([], TEST_REPO_MAP)).toBe('The plan needs at least one PR in its breakdown');
    expect(validateBreakdown([{ repo: 'core', scope: '  ' }], TEST_REPO_MAP)).toBe('PR 1 has no scope');
    expect(validateBreakdown([{ repo: 'core', scope: 'a' }, { repo: 'mobile', scope: 'b' }], TEST_REPO_MAP)).toBe(
      'PR 2 uses unknown repository "mobile". Known: core, web, infra',
    );
    expect(validateBreakdown([{ repo: 'web', scope: 'show field' }], TEST_REPO_MAP)).toBeNull();
  });
});
```

`src/core/work/plans.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { cleanPlanContent, latestPlan, listPlans, renderPlanComment, savePlan } from './plans';

const content = {
  body: 'Root cause: the webhook parser disables the JSON parser.\n\nApproach: scope it to /webhooks.',
  breakdown: [
    { repo: 'core', scope: 'Scope raw-body parser to webhook routes' },
    { repo: 'web', scope: 'Show error banner' },
  ],
};

describe('plans', () => {
  it('versions plans per item', () => {
    const db = createTestDb();
    const item = seedItem(db);
    savePlan(db, item.id, content, 'claude', null, 1);
    const v2 = savePlan(db, item.id, { ...content, body: 'Edited' }, 'user', null, 2);
    expect(v2.version).toBe(2);
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, author: 'user', body: 'Edited' });
    expect(listPlans(db, item.id).map((p) => p.version)).toEqual([1, 2]);
  });

  it('cleans content by trimming and dropping empty breakdown rows', () => {
    expect(
      cleanPlanContent({ body: '  body  ', breakdown: [{ repo: ' core ', scope: ' a ' }, { repo: '', scope: '' }] }),
    ).toEqual({ body: 'body', breakdown: [{ repo: 'core', scope: 'a' }] });
  });

  it('renders the Linear comment', () => {
    expect(renderPlanComment(content)).toBe(
      '## Implementation plan\n\n' +
        'Root cause: the webhook parser disables the JSON parser.\n\nApproach: scope it to /webhooks.\n\n' +
        '### PR breakdown\n' +
        '1. `core` — Scope raw-body parser to webhook routes\n' +
        '2. `web` — Show error banner\n',
    );
  });
});
```

`src/core/work/planned-prs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { savePlan } from './plans';
import {
  allPrsOpen,
  branchName,
  createPlannedPrs,
  listPlannedPrs,
  nextPendingPr,
  prRollup,
  updatePlannedPr,
} from './planned-prs';

describe('branchName', () => {
  it('builds {team}-{number}-{slug} in lowercase, max 40 slug chars', () => {
    expect(branchName('BOO-1430', 'Scope raw-body parser to /webhooks!')).toBe('boo-1430-scope-raw-body-parser-to-webhooks');
    expect(branchName('BOO-1', '***')).toBe('boo-1-change');
    expect(branchName('BOO-2', 'a'.repeat(60))).toBe(`boo-2-${'a'.repeat(40)}`);
  });
});

describe('planned PRs', () => {
  function setup() {
    const db = createTestDb();
    const item = seedItem(db, { linearIdentifier: 'BOO-7', linearIssueId: 'i7' });
    const plan = savePlan(
      db,
      item.id,
      {
        body: 'b',
        breakdown: [
          { repo: 'core', scope: 'Add field' },
          { repo: 'web', scope: 'Add field' },
        ],
      },
      'claude',
      null,
      1,
    );
    return { db, item, plan };
  }

  it('creates one row per breakdown entry with unique branches', () => {
    const { db, item, plan } = setup();
    const rows = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5);
    expect(rows.map((r) => [r.position, r.repoKey, r.githubRepo, r.branch, r.state])).toEqual([
      [1, 'core', 'acme/core', 'boo-7-add-field', 'pending'],
      [2, 'web', 'acme/web', 'boo-7-add-field-2', 'pending'],
    ]);
    expect(nextPendingPr(db, item.id)?.position).toBe(1);
  });

  it('refuses unknown repositories', () => {
    const { db, item } = setup();
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'mobile', scope: 'x' }] }, 'user', null, 2);
    expect(() => createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5)).toThrow(PermanentError);
  });

  it('knows when every PR is open', () => {
    const { db, item, plan } = setup();
    const [a, b] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 5);
    expect(allPrsOpen(db, item.id)).toBe(false);
    updatePlannedPr(db, a!.id, { state: 'open', prNumber: 1 }, 6);
    expect(nextPendingPr(db, item.id)?.id).toBe(b!.id);
    updatePlannedPr(db, b!.id, { state: 'open', prNumber: 2 }, 7);
    expect(allPrsOpen(db, item.id)).toBe(true);
    expect(listPlannedPrs(db, item.id).map((p) => p.prNumber)).toEqual([1, 2]);
  });
});

describe('prRollup', () => {
  const pr = (state: 'pending' | 'open', ciState: 'none' | 'pending' | 'success' | 'failure', unresolvedThreads = 0) => ({
    state,
    ciState,
    unresolvedThreads,
  });

  it('counts opened PRs and sums unresolved threads of open PRs', () => {
    expect(prRollup([pr('open', 'success', 2), pr('open', 'success', 1), pr('pending', 'none', 9)])).toEqual({
      planned: 3,
      opened: 2,
      ci: 'success',
      unresolved: 3,
    });
  });

  it('ranks failure over pending over success and ignores PRs without checks', () => {
    expect(prRollup([pr('open', 'success'), pr('open', 'failure'), pr('open', 'pending')]).ci).toBe('failure');
    expect(prRollup([pr('open', 'success'), pr('open', 'pending')]).ci).toBe('pending');
    expect(prRollup([pr('open', 'success'), pr('open', 'none')]).ci).toBe('success');
    expect(prRollup([pr('open', 'none'), pr('pending', 'none')]).ci).toBe('none');
    expect(prRollup([])).toEqual({ planned: 0, opened: 0, ci: 'none', unresolved: 0 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/core/work src/core/repos`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement `src/core/work/machine.ts`**

```ts
import type { WorkState } from '../db/schema';

export type WorkEvent =
  | { type: 'start' }
  | { type: 'plan_saved' }
  | { type: 'user_edited' }
  | { type: 'revise_requested' }
  | { type: 'approved' }
  | { type: 'plan_posted' }
  | { type: 'all_prs_open' }
  | { type: 'job_failed' }
  | { type: 'retry'; to: WorkState };

export type WorkTransitionResult = { ok: true; state: WorkState } | { ok: false; error: string };

type SimpleEvent = Exclude<WorkEvent['type'], 'start' | 'retry'>;

const TABLE: Record<SimpleEvent, { from: readonly WorkState[]; to: WorkState; verb: string }> = {
  plan_saved: { from: ['investigating'], to: 'plan_ready', verb: 'save a plan' },
  user_edited: { from: ['plan_ready'], to: 'plan_ready', verb: 'edit the plan' },
  revise_requested: { from: ['plan_ready'], to: 'investigating', verb: 'revise the plan' },
  approved: { from: ['plan_ready'], to: 'posting_plan', verb: 'approve the plan' },
  plan_posted: { from: ['posting_plan'], to: 'implementing', verb: 'post the plan' },
  all_prs_open: { from: ['implementing'], to: 'prs_open', verb: 'finish implementation' },
  job_failed: { from: ['investigating', 'posting_plan', 'implementing'], to: 'failed', verb: 'fail' },
};

const RETRY_TARGETS: readonly WorkState[] = ['investigating', 'posting_plan', 'implementing'];

export function transitionWork(state: WorkState | null, event: WorkEvent): WorkTransitionResult {
  if (event.type === 'start') {
    return state === null ? { ok: true, state: 'investigating' } : { ok: false, error: `Work already started (${state})` };
  }
  if (event.type === 'retry') {
    if (state !== 'failed') return { ok: false, error: `Cannot retry while work is ${state ?? 'not started'}` };
    if (!RETRY_TARGETS.includes(event.to)) return { ok: false, error: `Cannot retry into ${event.to}` };
    return { ok: true, state: event.to };
  }
  const rule = TABLE[event.type];
  if (state === null || !rule.from.includes(state)) {
    return { ok: false, error: `Cannot ${rule.verb} while work is ${state ?? 'not started'}` };
  }
  return { ok: true, state: rule.to };
}
```

- [ ] **Step 5: Implement `src/core/work/state.ts`**

```ts
import type { Db } from '../db/client';
import type { Item, WorkState } from '../db/schema';
import { ActionError } from '../errors';
import { getItem, logActivity, requireItem, updateItem } from '../items';
import { transitionWork, type WorkEvent } from './machine';

export function applyWorkEvent(db: Db, itemId: number, event: WorkEvent, now = Date.now()): Item {
  const item = requireItem(db, itemId);
  const result = transitionWork(item.workState, event);
  if (!result.ok) throw new ActionError(`Item #${itemId}: ${result.error}`);
  return updateItem(db, itemId, { workState: result.state, lastError: null }, now);
}

export function markWorkFailed(
  db: Db,
  itemId: number,
  fromState: WorkState | null,
  message: string,
  now = Date.now(),
): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const canFail = fromState !== null && transitionWork(item.workState, { type: 'job_failed' }).ok;
  updateItem(
    db,
    itemId,
    canFail ? { workState: 'failed', workFailedFromState: fromState, lastError: message } : { lastError: message },
    now,
  );
  logActivity(db, itemId, `Failed: ${message}`, now);
}
```

- [ ] **Step 6: Implement `src/core/repos/map.ts`**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BreakdownEntry } from '../db/schema';
import { errorMessage, PermanentError } from '../errors';

const repoSchema = z.object({
  key: z.string().min(1),
  repo: z.string().min(1),
  url: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
  type: z.string().min(1).default('node'),
  node: z.string().optional(),
  packageManager: z.string().optional(),
  installCommand: z.string().default(''),
  awsProfile: z.string().optional(),
  validationCommands: z.array(z.string()).default([]),
  envTargets: z.array(z.object({ document: z.string(), path: z.string() })).default([]),
  aliases: z.array(z.string()).default([]),
});

const mapSchema = z.object({
  defaults: z.object({
    awsRegion: z.string().min(1),
    awsAccountId: z.string().min(1),
    codeArtifactDomain: z.string().min(1),
    codeArtifactRegistry: z.string().min(1),
    awsProfile: z.string().optional(),
  }),
  repositories: z.array(repoSchema),
});

export type RepoEntry = z.infer<typeof repoSchema>;
export type RepoDefaults = z.infer<typeof mapSchema>['defaults'];
export type RepoMap = { defaults: RepoDefaults; repos: RepoEntry[] };

export function parseRepoMap(raw: unknown): RepoMap {
  const result = mapSchema.safeParse(raw);
  if (!result.success) throw new PermanentError(`Invalid repository map: ${z.prettifyError(result.error)}`);
  return { defaults: result.data.defaults, repos: result.data.repositories };
}

/** Reads `<skillDir>/config/repositories.json` from the user's meetingpackage skill. */
export function loadRepoMap(skillDir: string): RepoMap {
  const file = path.join(skillDir, 'config', 'repositories.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new PermanentError(`Cannot read repository map ${file}: ${errorMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PermanentError(`Repository map ${file} is not valid JSON: ${errorMessage(err)}`);
  }
  return parseRepoMap(raw);
}

export function findRepo(map: RepoMap, key: string): RepoEntry | undefined {
  return map.repos.find((r) => r.key === key);
}

/** Returns a user-facing error for an unusable breakdown, or null when it is fine. */
export function validateBreakdown(breakdown: BreakdownEntry[], map: RepoMap): string | null {
  if (breakdown.length === 0) return 'The plan needs at least one PR in its breakdown';
  for (const [index, entry] of breakdown.entries()) {
    if (!entry.scope.trim()) return `PR ${index + 1} has no scope`;
    if (!findRepo(map, entry.repo)) {
      return `PR ${index + 1} uses unknown repository "${entry.repo}". Known: ${map.repos.map((r) => r.key).join(', ')}`;
    }
  }
  return null;
}
```

- [ ] **Step 7: Implement `src/core/work/plans.ts`**

```ts
import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type BreakdownEntry, type Plan, plans } from '../db/schema';

export type PlanContent = { body: string; breakdown: BreakdownEntry[] };

export function latestPlan(db: Db, itemId: number): Plan | undefined {
  return db.select().from(plans).where(eq(plans.itemId, itemId)).orderBy(desc(plans.version)).get();
}

export function listPlans(db: Db, itemId: number): Plan[] {
  return db.select().from(plans).where(eq(plans.itemId, itemId)).orderBy(asc(plans.version)).all();
}

export function savePlan(
  db: Db,
  itemId: number,
  content: PlanContent,
  author: 'claude' | 'user',
  feedback: string | null,
  now = Date.now(),
): Plan {
  const version = (latestPlan(db, itemId)?.version ?? 0) + 1;
  return db
    .insert(plans)
    .values({ itemId, version, body: content.body, breakdown: content.breakdown, author, feedback, createdAt: now })
    .returning()
    .get();
}

export function cleanPlanContent(content: PlanContent): PlanContent {
  return {
    body: content.body.trim(),
    breakdown: content.breakdown
      .map((e) => ({ repo: e.repo.trim(), scope: e.scope.trim() }))
      .filter((e) => e.repo || e.scope),
  };
}

export function renderPlanComment(content: PlanContent): string {
  const rows = content.breakdown.map((e, i) => `${i + 1}. \`${e.repo}\` — ${e.scope.trim()}`).join('\n');
  return `## Implementation plan\n\n${content.body.trim()}\n\n### PR breakdown\n${rows}\n`;
}
```

- [ ] **Step 8: Implement `src/core/work/planned-prs.ts`**

```ts
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type CiState, type Item, type Plan, type PlannedPr, plannedPrs } from '../db/schema';
import { PermanentError } from '../errors';
import { findRepo, type RepoMap } from '../repos/map';

export type PlannedPrPatch = Partial<
  Pick<
    PlannedPr,
    'state' | 'prNumber' | 'prUrl' | 'branch' | 'isDraft' | 'merged' | 'unresolvedThreads' | 'ciState' | 'polledAt' | 'lastError'
  >
>;

export function branchName(identifier: string, scope: string): string {
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${identifier.toLowerCase()}-${slug || 'change'}`;
}

export function createPlannedPrs(db: Db, item: Item, plan: Plan, map: RepoMap, now = Date.now()): PlannedPr[] {
  const identifier = item.linearIdentifier;
  if (!identifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const used = new Set<string>();
  return plan.breakdown.map((entry, index) => {
    const repo = findRepo(map, entry.repo);
    if (!repo) throw new PermanentError(`Unknown repository "${entry.repo}"`);
    let branch = branchName(identifier, entry.scope);
    if (used.has(branch)) branch = `${branch}-${index + 1}`;
    used.add(branch);
    return db
      .insert(plannedPrs)
      .values({
        itemId: item.id,
        planVersion: plan.version,
        position: index + 1,
        repoKey: repo.key,
        githubRepo: repo.repo,
        scope: entry.scope,
        branch,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

export function listPlannedPrs(db: Db, itemId: number): PlannedPr[] {
  return db.select().from(plannedPrs).where(eq(plannedPrs.itemId, itemId)).orderBy(asc(plannedPrs.position)).all();
}

export function getPlannedPr(db: Db, id: number): PlannedPr | undefined {
  return db.select().from(plannedPrs).where(eq(plannedPrs.id, id)).get();
}

export function updatePlannedPr(db: Db, id: number, patch: PlannedPrPatch, now = Date.now()): PlannedPr {
  return db
    .update(plannedPrs)
    .set({ ...patch, updatedAt: now })
    .where(eq(plannedPrs.id, id))
    .returning()
    .get();
}

export function nextPendingPr(db: Db, itemId: number): PlannedPr | undefined {
  return db
    .select()
    .from(plannedPrs)
    .where(and(eq(plannedPrs.itemId, itemId), eq(plannedPrs.state, 'pending')))
    .orderBy(asc(plannedPrs.position))
    .get();
}

export function allPrsOpen(db: Db, itemId: number): boolean {
  const all = listPlannedPrs(db, itemId);
  return all.length > 0 && all.every((p) => p.state === 'open');
}

/** First planned PR that is not open yet, for resuming implementation. */
export function firstUnfinishedPr(db: Db, itemId: number): PlannedPr | undefined {
  return db
    .select()
    .from(plannedPrs)
    .where(and(eq(plannedPrs.itemId, itemId), ne(plannedPrs.state, 'open')))
    .orderBy(asc(plannedPrs.position))
    .get();
}

export type PrRollup = { planned: number; opened: number; ci: CiState; unresolved: number };

export function prRollup(prs: Pick<PlannedPr, 'state' | 'ciState' | 'unresolvedThreads'>[]): PrRollup {
  const open = prs.filter((p) => p.state === 'open');
  const checked = open.map((p) => p.ciState).filter((c) => c !== 'none');
  const ci: CiState = checked.includes('failure')
    ? 'failure'
    : checked.includes('pending')
      ? 'pending'
      : checked.length > 0
        ? 'success'
        : 'none';
  return {
    planned: prs.length,
    opened: open.length,
    ci,
    unresolved: open.reduce((sum, p) => sum + p.unresolvedThreads, 0),
  };
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run src/core && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/core/work src/core/repos src/test/repo-map.ts
git commit -m "feat: add work state machine, repo map, plans and planned PRs" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 3: Workspaces, runs, stream parsing, job routing and shared job execution

**Files:**
- Create: `src/core/work/workspaces.ts`, `src/core/work/runs.ts`, `src/core/work/stream.ts`, `src/worker/execute.ts`
- Modify: `src/core/jobs/queue.ts`, `src/worker/runner.ts`, `src/worker/main.ts` (only the `recoverRunningJobs` call stays the same)
- Test: `src/core/work/workspaces.test.ts`, `src/core/work/runs.test.ts`, `src/core/work/stream.test.ts`, `src/core/jobs/queue.test.ts` (extend), `src/worker/runner.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 schema; Task 2 `markWorkFailed`, `updatePlannedPr`.
- Produces:
  - `workspaces.ts`:
    - `workspaceName(identifier): string`, `getWorkspace(db, itemId): Workspace | undefined`
    - `createWorkspaceRow(db, { itemId, container, volume, image }, now?): Workspace`
    - `updateWorkspace(db, itemId, patch: Partial<Pick<Workspace, 'status' | 'repos' | 'lastUsedAt'>>, now?): Workspace | undefined`
  - `runs.ts`:
    - `startRun(db, { jobId, itemId, plannedPrId, kind, logPath }, now?): AgentRun`
    - `finishRun(db, runId, outcome: RunOutcome, summary: string | null, now?): void`
    - `activeRun(db, itemId): AgentRun | undefined`, `listRuns(db, itemId, limit?): AgentRun[]`, `getRun(db, id): AgentRun | undefined`
  - `stream.ts`:
    - `StreamEvent = { type: 'session'; sessionId: string } | { type: 'text'; text: string } | { type: 'tool'; name: string; summary: string } | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null }`
    - `parseStreamLine(line: string): StreamEvent[]`, `displayLines(lines: string[], limit?: number): string[]`
  - `queue.ts`:
    - `JobPayloads` gains: `investigate: { feedback?: string }`, `'post-plan': { commentUuid: string }`, `'implement-pr': { plannedPrId: number }`, `'fix-pr': { plannedPrId: number }`, `'remove-workspace': Record<string, never>`
    - `claimNextJob(db, now?, types?: readonly JobType[]): Job | null`
    - `JobStartState = { triage: TriageState | null; work: WorkState | null }`
    - `recordJobFailure(db, job, start: JobStartState, message, now?)` (the signature changes)
    - `latestFailedJob(db, itemId, types?: readonly JobType[])`
    - `isStopRequested(db, jobId): boolean`, `requestStop(db, jobId): void`, `runningAgentJob(db, itemId): Job | undefined`
  - `src/worker/execute.ts`: `executeJob(db: Db, job: Job, run: () => Promise<void>, now: () => number): Promise<void>`
  - `runner.ts`: `HANDLERS: Partial<Record<JobType, Handler>>`. `runNextJob` claims only `CORE_JOB_TYPES`.

- [ ] **Step 1: Write the failing tests**

`src/core/work/workspaces.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { createWorkspaceRow, getWorkspace, updateWorkspace, workspaceName } from './workspaces';

describe('workspaces', () => {
  it('names workspaces after the Linear identifier', () => {
    expect(workspaceName('BOO-1430')).toBe('wf-boo-1430');
  });

  it('creates and re-creates the row, resetting repos', () => {
    const db = createTestDb();
    const item = seedItem(db);
    createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 1);
    updateWorkspace(db, item.id, { status: 'ready', repos: ['core'] }, 2);
    expect(getWorkspace(db, item.id)).toMatchObject({ status: 'ready', repos: ['core'], lastUsedAt: 2 });
    const again = createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img2' }, 3);
    expect(again).toMatchObject({ status: 'creating', repos: [], image: 'img2', createdAt: 1, lastUsedAt: 3 });
  });
});
```

`src/core/work/runs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { enqueueJob } from '@/core/jobs/queue';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { activeRun, finishRun, listRuns, startRun } from './runs';

describe('agent runs', () => {
  it('tracks one active run per item and finishes it', () => {
    const db = createTestDb();
    const item = seedItem(db);
    const job = enqueueJob(db, 'investigate', item.id, {}, 1);
    const run = startRun(db, { jobId: job.id, itemId: item.id, plannedPrId: null, kind: 'investigate', logPath: '/tmp/x.jsonl' }, 2);
    expect(activeRun(db, item.id)?.id).toBe(run.id);
    finishRun(db, run.id, 'succeeded', 'Plan with 2 PRs', 3);
    expect(activeRun(db, item.id)).toBeUndefined();
    expect(listRuns(db, item.id)).toMatchObject([{ outcome: 'succeeded', summary: 'Plan with 2 PRs', endedAt: 3 }]);
  });
});
```

`src/core/work/stream.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { displayLines, parseStreamLine } from './stream';

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });
const assistant = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'Reading the parser' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/work/core/src/main.ts' } },
    ],
  },
});
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', session_id: 's-1' });
const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's-1' });

describe('parseStreamLine', () => {
  it('extracts session, text, tool calls and results', () => {
    expect(parseStreamLine(init)).toEqual([{ type: 'session', sessionId: 's-1' }]);
    expect(parseStreamLine(assistant)).toEqual([
      { type: 'text', text: 'Reading the parser' },
      { type: 'tool', name: 'Read', summary: '{"file_path":"/work/core/src/main.ts"}' },
    ]);
    expect(parseStreamLine(result)).toEqual([{ type: 'result', ok: true, subtype: 'success', text: '{"ok":true}', sessionId: 's-1' }]);
    expect(parseStreamLine(failed)).toEqual([{ type: 'result', ok: false, subtype: 'error_max_turns', text: '', sessionId: 's-1' }]);
  });

  it('ignores blank, non-JSON and unknown lines', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('not json')).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: 'user' }))).toEqual([]);
  });
});

describe('displayLines', () => {
  it('renders the last N text and tool lines', () => {
    expect(displayLines([init, assistant, result], 2)).toEqual([
      '🔧 Read {"file_path":"/work/core/src/main.ts"}',
      '✅ Finished (success)',
    ]);
  });
});
```

Add to `src/core/jobs/queue.test.ts` (keep the existing tests; also add `latestFailedJob` and the new functions to the import list, and `import { markWorkFailed } from '@/core/work/state';` is not needed):
```ts
import { getItem } from '@/core/items';
import { getPlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createPlannedPrs } from '@/core/work/planned-prs';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { isStopRequested, recordJobFailure, requestStop, runningAgentJob } from './queue';

describe('typed claims and failure routing', () => {
  it('claims only the requested job types', () => {
    enqueueJob(db, 'investigate', itemId, {}, 0);
    const draft = enqueueJob(db, 'draft', itemId, {}, 1);
    expect(claimNextJob(db, 5, ['draft'])?.id).toBe(draft.id);
    expect(claimNextJob(db, 5, ['draft'])).toBeNull();
    expect(claimNextJob(db, 5, ['investigate'])?.type).toBe('investigate');
  });

  it('fails work for investigate jobs and keeps triage untouched', () => {
    const item = seedItem(db, { workState: 'investigating', triageState: 'linked' });
    const job = enqueueJob(db, 'investigate', item.id, {}, 0);
    recordJobFailure(db, job, { triage: 'linked', work: 'investigating' }, 'boom', 1);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'failed', workFailedFromState: 'investigating', triageState: 'linked' });
  });

  it('marks the planned PR failed for implement-pr', () => {
    const item = seedItem(db, { workState: 'implementing', linearIdentifier: 'BOO-1', linearIssueId: 'i1' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
    const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    const job = enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr!.id }, 0);
    recordJobFailure(db, job, { triage: null, work: 'implementing' }, 'push rejected', 1);
    expect(getPlannedPr(db, pr!.id)).toMatchObject({ state: 'failed', lastError: 'push rejected' });
    expect(getItem(db, item.id)?.workState).toBe('failed');
  });

  it('keeps the work state when a fix round fails', () => {
    const item = seedItem(db, { workState: 'prs_open', linearIdentifier: 'BOO-1', linearIssueId: 'i1' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'user', null, 0);
    const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    const job = enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr!.id }, 0);
    recordJobFailure(db, job, { triage: null, work: 'prs_open' }, 'timed out', 1);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', lastError: 'timed out' });
    expect(getPlannedPr(db, pr!.id)?.lastError).toBe('timed out');
  });

  it('finds the latest failed job of given types', () => {
    const job = enqueueJob(db, 'investigate', itemId, {}, 0);
    failJob(db, claimNextJob(db, 0)!, new PermanentError('x'), 0);
    enqueueJob(db, 'draft', itemId, {}, 1);
    failJob(db, claimNextJob(db, 1)!, new PermanentError('y'), 2);
    expect(latestFailedJob(db, itemId, ['investigate'])?.id).toBe(job.id);
  });

  it('flags a running agent job for stopping', () => {
    const job = enqueueJob(db, 'implement-pr', itemId, { plannedPrId: 1 }, 0);
    expect(runningAgentJob(db, itemId)).toBeUndefined();
    claimNextJob(db, 0);
    expect(runningAgentJob(db, itemId)?.id).toBe(job.id);
    expect(isStopRequested(db, job.id)).toBe(false);
    requestStop(db, job.id);
    expect(isStopRequested(db, job.id)).toBe(true);
  });
});
```

Add to `src/worker/runner.test.ts`:
```ts
describe('core lane', () => {
  it('never claims agent jobs', async () => {
    const item = seedItem(db, { triageState: 'drafting' });
    const agentJob = enqueueJob(db, 'investigate', item.id, {}, 0);
    enqueueJob(db, 'draft', item.id, {}, 0);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(true);
    await expect(runNextJob(ctx, withDraftHandler(async () => {}))).resolves.toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, agentJob.id)).get()?.status).toBe('queued');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/work src/core/jobs src/worker/runner.test.ts`
Expected: FAIL. The new modules don't exist, `claimNextJob` ignores types, and `recordJobFailure` has the old signature.

- [ ] **Step 3: Implement `src/core/work/workspaces.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Workspace, workspaces } from '../db/schema';

export function workspaceName(identifier: string): string {
  return `wf-${identifier.toLowerCase()}`;
}

export function getWorkspace(db: Db, itemId: number): Workspace | undefined {
  return db.select().from(workspaces).where(eq(workspaces.itemId, itemId)).get();
}

/** Inserts the row, or resets an existing (e.g. removed) one to `creating` with no repos. */
export function createWorkspaceRow(
  db: Db,
  input: { itemId: number; container: string; volume: string; image: string },
  now = Date.now(),
): Workspace {
  return db
    .insert(workspaces)
    .values({ ...input, status: 'creating', repos: [], createdAt: now, lastUsedAt: now })
    .onConflictDoUpdate({
      target: workspaces.itemId,
      set: { container: input.container, volume: input.volume, image: input.image, status: 'creating', repos: [], lastUsedAt: now },
    })
    .returning()
    .get();
}

export function updateWorkspace(
  db: Db,
  itemId: number,
  patch: Partial<Pick<Workspace, 'status' | 'repos' | 'lastUsedAt'>>,
  now = Date.now(),
): Workspace | undefined {
  return db
    .update(workspaces)
    .set({ lastUsedAt: now, ...patch })
    .where(eq(workspaces.itemId, itemId))
    .returning()
    .get();
}
```

- [ ] **Step 4: Implement `src/core/work/runs.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type AgentRun, type AgentRunKind, agentRuns, type RunOutcome } from '../db/schema';

export function startRun(
  db: Db,
  input: { jobId: number; itemId: number; plannedPrId: number | null; kind: AgentRunKind; logPath: string },
  now = Date.now(),
): AgentRun {
  return db
    .insert(agentRuns)
    .values({ ...input, startedAt: now, outcome: 'running' })
    .returning()
    .get();
}

export function finishRun(db: Db, runId: number, outcome: RunOutcome, summary: string | null, now = Date.now()): void {
  db.update(agentRuns).set({ outcome, summary, endedAt: now }).where(eq(agentRuns.id, runId)).run();
}

export function activeRun(db: Db, itemId: number): AgentRun | undefined {
  return db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.itemId, itemId), eq(agentRuns.outcome, 'running')))
    .orderBy(desc(agentRuns.id))
    .get();
}

export function getRun(db: Db, id: number): AgentRun | undefined {
  return db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
}

export function listRuns(db: Db, itemId: number, limit = 10): AgentRun[] {
  return db.select().from(agentRuns).where(eq(agentRuns.itemId, itemId)).orderBy(desc(agentRuns.id)).limit(limit).all();
}
```

- [ ] **Step 5: Implement `src/core/work/stream.ts`**

```ts
/** Events from `claude -p --output-format stream-json --verbose` lines that the app cares about. */
export type StreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'result'; ok: boolean; subtype: string; text: string; sessionId: string | null };

type RawContent = { type?: string; text?: string; name?: string; input?: unknown };
type RawLine = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: RawContent[] };
};

export function parseStreamLine(line: string): StreamEvent[] {
  if (!line.trim()) return [];
  let raw: RawLine;
  try {
    raw = JSON.parse(line) as RawLine;
  } catch {
    return [];
  }
  if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) return [{ type: 'session', sessionId: raw.session_id }];
  if (raw.type === 'result') {
    return [
      {
        type: 'result',
        ok: raw.subtype === 'success' && !raw.is_error,
        subtype: raw.subtype ?? 'unknown',
        text: raw.result ?? '',
        sessionId: raw.session_id ?? null,
      },
    ];
  }
  if (raw.type === 'assistant') {
    const events: StreamEvent[] = [];
    for (const part of raw.message?.content ?? []) {
      if (part.type === 'text' && part.text) events.push({ type: 'text', text: part.text });
      if (part.type === 'tool_use' && part.name) {
        events.push({ type: 'tool', name: part.name, summary: JSON.stringify(part.input ?? {}).slice(0, 160) });
      }
    }
    return events;
  }
  return [];
}

/** Human-readable tail of a run log for the dashboard. */
export function displayLines(lines: string[], limit = 30): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const event of parseStreamLine(line)) {
      if (event.type === 'text') out.push(`💬 ${event.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (event.type === 'tool') out.push(`🔧 ${event.name} ${event.summary}`);
      if (event.type === 'result') out.push(event.ok ? `✅ Finished (${event.subtype})` : `❌ Ended (${event.subtype})`);
    }
  }
  return out.slice(-limit);
}
```

- [ ] **Step 6: Update `src/core/jobs/queue.ts`**

Replace the imports and the `JobPayloads` type:
```ts
import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { AGENT_JOB_TYPES, type Job, type JobType, jobs, type TriageState, type WorkState } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';
import { getItem, logActivity, markItemFailed, updateItem } from '../items';
import { writeTransaction } from '../db/tx';
import { updatePlannedPr } from '../work/planned-prs';
import { markWorkFailed } from '../work/state';
import { updateWorkspace } from '../work/workspaces';

export type JobPayloads = {
  'triage-draft': Record<string, never>;
  draft: { feedback?: string };
  /** Client-generated Linear issue id. A retry reuses it, so a lost create response can never create a second issue. */
  'create-linear-issue': { issueUuid: string };
  'link-linear-issue': { identifier: string; issueId?: string };
  investigate: { feedback?: string };
  /** Client-generated Linear comment id, so a retried post never creates a second comment. */
  'post-plan': { commentUuid: string };
  'implement-pr': { plannedPrId: number };
  'fix-pr': { plannedPrId: number };
  'remove-workspace': Record<string, never>;
};

export type JobStartState = { triage: TriageState | null; work: WorkState | null };
```

Replace `claimNextJob`:
```ts
export function claimNextJob(db: Db, now = Date.now(), types?: readonly JobType[]): Job | null {
  return writeTransaction(db, (tx) => {
    const due = and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now));
    const next = tx
      .select()
      .from(jobs)
      .where(types ? and(due, inArray(jobs.type, [...types])) : due)
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
```

Replace `recordJobFailure`:
```ts
/**
 * Records on the item that `job` failed for good.
 * - Link and fix jobs start from states where the user is choosing, so they keep that state.
 * - Work jobs fail the work state.
 * - Triage jobs fail the triage state.
 */
export function recordJobFailure(db: Db, job: Job, start: JobStartState, message: string, now = Date.now()): void {
  switch (job.type) {
    case 'link-linear-issue': {
      const { identifier } = jobPayload(job as Job & { type: 'link-linear-issue' });
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Link to ${identifier} failed: ${message}`, now);
      return;
    }
    case 'fix-pr': {
      const { plannedPrId } = jobPayload(job as Job & { type: 'fix-pr' });
      updatePlannedPr(db, plannedPrId, { lastError: message }, now);
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Fix round failed: ${message}`, now);
      return;
    }
    case 'remove-workspace':
      updateWorkspace(db, job.itemId, { status: 'broken' }, now);
      updateItem(db, job.itemId, { lastError: message }, now);
      logActivity(db, job.itemId, `Removing the workspace failed: ${message}`, now);
      return;
    case 'implement-pr': {
      const { plannedPrId } = jobPayload(job as Job & { type: 'implement-pr' });
      updatePlannedPr(db, plannedPrId, { state: 'failed', lastError: message }, now);
      markWorkFailed(db, job.itemId, start.work, message, now);
      return;
    }
    case 'investigate':
    case 'post-plan':
      markWorkFailed(db, job.itemId, start.work, message, now);
      return;
    default:
      markItemFailed(db, job.itemId, start.triage, message, now);
  }
}
```

In `recoverRunningJobs`, change the failure call to:
```ts
    for (const job of exhausted) {
      const item = getItem(tx, job.itemId);
      recordJobFailure(tx, job, { triage: item?.triageState ?? null, work: item?.workState ?? null }, CRASHED_MESSAGE, now);
    }
```

Replace `latestFailedJob` and append the new helpers:
```ts
export function latestFailedJob(db: Db, itemId: number, types?: readonly JobType[]): Job | undefined {
  const failed = and(eq(jobs.itemId, itemId), eq(jobs.status, 'failed'));
  return db
    .select()
    .from(jobs)
    .where(types ? and(failed, inArray(jobs.type, [...types])) : failed)
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .get();
}

export function runningAgentJob(db: Db, itemId: number): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.status, 'running'), inArray(jobs.type, [...AGENT_JOB_TYPES])))
    .get();
}

export function requestStop(db: Db, jobId: number): void {
  db.update(jobs).set({ stopRequested: true }).where(eq(jobs.id, jobId)).run();
}

export function isStopRequested(db: Db, jobId: number): boolean {
  return db.select({ stop: jobs.stopRequested }).from(jobs).where(eq(jobs.id, jobId)).get()?.stop ?? false;
}
```
`requeueJob` must also clear the stop flag. Change its `.set({...})` to `{ status: 'queued', attempts: 0, runAfter: now, lastError: null, stopRequested: false, updatedAt: now }`.

- [ ] **Step 7: Implement `src/worker/execute.ts`**

```ts
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';
import { errorMessage } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { completeJob, failJob, recordJobFailure } from '@/core/jobs/queue';

/**
 * Runs one claimed job and records the outcome. Shared by the core lane and the agent lane.
 * Failure bookkeeping errors are logged, never thrown, so they cannot crash the worker.
 */
export async function executeJob(db: Db, job: Job, run: () => Promise<void>, now: () => number): Promise<void> {
  const item = getItem(db, job.itemId);
  const start = { triage: item?.triageState ?? null, work: item?.workState ?? null };
  try {
    await run();
    completeJob(db, job.id, now());
  } catch (err) {
    const message = errorMessage(err);
    const t = now();
    try {
      if (failJob(db, job, err, t) === 'failed') {
        recordJobFailure(db, job, start, message, t);
      } else {
        logActivity(db, job.itemId, `Retrying ${job.type} later: ${message}`, t);
      }
    } catch (bookkeepingErr) {
      // A DB error here (e.g. SQLITE_BUSY) must not crash the worker. The job stays `running`
      // and crash recovery picks it up on the next start.
      console.error(`[worker] Could not record the failure of job #${job.id}: ${errorMessage(bookkeepingErr)}`);
    }
  }
}
```

- [ ] **Step 8: Update `src/worker/runner.ts` to use it**

Replace the imports from `@/core/jobs/queue` and `@/core/items` (they are no longer needed for bookkeeping) and the `HANDLERS`/`runNextJob` definitions:
```ts
import { CORE_JOB_TYPES, type JobType } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { claimNextJob } from '@/core/jobs/queue';
import { executeJob } from './execute';
```
```ts
export const HANDLERS: Partial<Record<JobType, Handler>> = {
  'triage-draft': triageDraftHandler,
  draft: draftHandler,
  'create-linear-issue': createLinearIssueHandler,
  'link-linear-issue': linkLinearIssueHandler,
};

export async function runNextJob(ctx: HandlerContext, handlers: Partial<Record<JobType, Handler>> = HANDLERS): Promise<boolean> {
  const job = claimNextJob(ctx.db, ctx.now(), CORE_JOB_TYPES);
  if (!job) return false;
  const handler = handlers[job.type];
  await executeJob(
    ctx.db,
    job,
    () => (handler ? handler(ctx, job) : Promise.reject(new PermanentError(`No handler for ${job.type}`))),
    ctx.now,
  );
  return true;
}
```
Keep `errorMessage`, `logActivity` and the other imports only if `pollOnce` still uses them. Remove unused imports so `tsc` stays clean.

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/core/work src/core/jobs src/worker/execute.ts src/worker/runner.ts src/worker/runner.test.ts
git commit -m "feat: add workspace and run records, stream parsing and typed job lanes" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 4: Work actions, re-arm and the start-investigation rule

**Files:**
- Create: `src/core/actions/work.ts`, `src/core/repos/current.ts`, `src/core/work/gc.ts`
- Modify: `src/core/actions/index.ts`, `src/core/jobs/rearm.ts`, `src/core/ingest.ts`
- Test: `src/core/actions/work.test.ts`, `src/core/work/gc.test.ts`, `src/core/ingest.test.ts` (extend), `src/core/repos/current.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `actions/work.ts`:
    - `startInvestigation(db, itemId, now?): Item`
    - `editPlan(db, itemId, content: PlanContent, map: RepoMap, now?): Plan`
    - `revisePlan(db, itemId, feedback: string, now?): Item`
    - `approvePlan(db, itemId, map: RepoMap, now?): Item`
    - `retryWork(db, itemId, now?): Item`
    - `fixPr(db, itemId, plannedPrId: number, now?): Item`
    - `stopRun(db, itemId, now?): Item`
    - `removeWorkspace(db, itemId, now?): Item`
  - `repos/current.ts`: `loadCurrentRepoMap(): RepoMap` (throws `ActionError`), `knownRepoKeys(): string[]` (empty list on error)
  - `work/gc.ts`: `enqueueWorkspaceGc(db, retentionDays: number, now?): number`
  - `jobs/rearm.ts`: `rearmStrandedJob(db, item, now?)` now also re-arms `investigating` (investigate), `posting_plan` (post-plan, reusing the `commentUuid`) and `implementing` (implement-pr for the first unfinished planned PR).

- [ ] **Step 1: Write the failing tests**

`src/core/actions/work.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { ActionError, PermanentError } from '@/core/errors';
import { getItem } from '@/core/items';
import { claimNextJob, enqueueJob, failJob, isStopRequested, recordJobFailure } from '@/core/jobs/queue';
import { createPlannedPrs, getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { latestPlan, savePlan } from '@/core/work/plans';
import { createWorkspaceRow, updateWorkspace } from '@/core/work/workspaces';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { approvePlan, editPlan, fixPr, removeWorkspace, retryWork, revisePlan, startInvestigation, stopRun } from './work';

const plan = { body: 'Scope the parser.', breakdown: [{ repo: 'core', scope: 'Scope raw parser' }] };
let db: Db;
beforeEach(() => {
  db = createTestDb();
});
const queued = () => db.select().from(jobs).all().filter((j) => j.status === 'queued');
const linearItem = (overrides = {}) =>
  seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', category: 'triage', ...overrides });

describe('startInvestigation', () => {
  it('starts investigating and enqueues one job, even when clicked twice', () => {
    const item = linearItem();
    expect(startInvestigation(db, item.id, 5).workState).toBe('investigating');
    expect(() => startInvestigation(db, item.id, 6)).toThrow(ActionError);
    expect(queued()).toMatchObject([{ type: 'investigate', payload: {} }]);
  });

  it('needs a Linear issue and refuses dismissed items', () => {
    expect(() => startInvestigation(db, seedItem(db).id)).toThrow(/no Linear issue/);
    expect(() => startInvestigation(db, linearItem({ category: 'dismissed', linearIssueId: 'i2' }).id)).toThrow(/dismissed/);
  });
});

describe('plan review', () => {
  function planReady() {
    const item = linearItem({ workState: 'plan_ready' });
    savePlan(db, item.id, plan, 'claude', null, 1);
    return item;
  }

  it('saves a cleaned user version and validates repos', () => {
    const item = planReady();
    editPlan(db, item.id, { body: ' Edited ', breakdown: [{ repo: 'web', scope: ' Banner ' }, { repo: '', scope: '' }] }, TEST_REPO_MAP, 5);
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, author: 'user', body: 'Edited', breakdown: [{ repo: 'web', scope: 'Banner' }] });
    expect(() => editPlan(db, item.id, { body: 'x', breakdown: [{ repo: 'mobile', scope: 'x' }] }, TEST_REPO_MAP)).toThrow(/unknown repository "mobile"/);
    expect(() => editPlan(db, item.id, { body: ' ', breakdown: plan.breakdown }, TEST_REPO_MAP)).toThrow(/body/);
  });

  it('revises with feedback', () => {
    const item = planReady();
    expect(() => revisePlan(db, item.id, '  ')).toThrow(/feedback/);
    expect(revisePlan(db, item.id, ' smaller PRs ', 5).workState).toBe('investigating');
    expect(queued()).toMatchObject([{ type: 'investigate', payload: { feedback: 'smaller PRs' } }]);
  });

  it('approves a valid plan once with a comment UUID', () => {
    const item = planReady();
    expect(approvePlan(db, item.id, TEST_REPO_MAP, 5).workState).toBe('posting_plan');
    expect(() => approvePlan(db, item.id, TEST_REPO_MAP, 6)).toThrow(ActionError);
    const [job] = queued();
    expect(job).toMatchObject({ type: 'post-plan' });
    expect((job!.payload as { commentUuid: string }).commentUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to approve a plan whose repos are no longer in the map', () => {
    const item = linearItem({ workState: 'plan_ready' });
    savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'gone', scope: 'x' }] }, 'claude', null, 1);
    expect(() => approvePlan(db, item.id, TEST_REPO_MAP)).toThrow(/unknown repository "gone"/);
  });
});

describe('retryWork', () => {
  it('requeues a failed implement-pr and resets its planned PR', () => {
    const item = linearItem({ workState: 'implementing' });
    const p = savePlan(db, item.id, plan, 'user', null, 1);
    const [pr] = createPlannedPrs(db, item, p, TEST_REPO_MAP, 1);
    enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr!.id }, 1);
    const claimed = claimNextJob(db, 1)!;
    failJob(db, claimed, new PermanentError('push rejected'), 2);
    recordJobFailure(db, claimed, { triage: null, work: 'implementing' }, 'push rejected', 2);

    expect(retryWork(db, item.id, 3)).toMatchObject({ workState: 'implementing', workFailedFromState: null, lastError: null });
    expect(getPlannedPr(db, pr!.id)).toMatchObject({ state: 'pending', lastError: null });
    expect(queued()).toMatchObject([{ id: claimed.id, type: 'implement-pr', attempts: 0 }]);
  });

  it('refuses when work has not failed', () => {
    expect(() => retryWork(db, linearItem({ workState: 'plan_ready' }).id)).toThrow(/has not failed/);
  });
});

describe('fixPr, stopRun and removeWorkspace', () => {
  function withOpenPr() {
    const item = linearItem({ workState: 'prs_open' });
    const p = savePlan(db, item.id, plan, 'user', null, 1);
    const [pr] = createPlannedPrs(db, item, p, TEST_REPO_MAP, 1);
    updatePlannedPr(db, pr!.id, { state: 'open', prNumber: 12 }, 2);
    return { item, pr: pr! };
  }

  it('enqueues one fix round for an open PR of this item', () => {
    const { item, pr } = withOpenPr();
    fixPr(db, item.id, pr.id, 5);
    expect(() => fixPr(db, item.id, pr.id, 6)).toThrow(/already has a job/);
    expect(queued()).toMatchObject([{ type: 'fix-pr', payload: { plannedPrId: pr.id } }]);
    const other = linearItem({ linearIssueId: 'i9', linearIdentifier: 'BOO-9', workState: 'prs_open' });
    expect(() => fixPr(db, other.id, pr.id)).toThrow(/not part of item/);
  });

  it('stops only a running agent job', () => {
    const { item, pr } = withOpenPr();
    expect(() => stopRun(db, item.id)).toThrow(/No agent run/);
    const job = enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr.id }, 1);
    claimNextJob(db, 1);
    stopRun(db, item.id, 2);
    expect(isStopRequested(db, job.id)).toBe(true);
  });

  it('enqueues workspace removal when a workspace exists', () => {
    const item = linearItem();
    expect(() => removeWorkspace(db, item.id)).toThrow(/no workspace/);
    createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 1);
    removeWorkspace(db, item.id, 2);
    expect(queued()).toMatchObject([{ type: 'remove-workspace' }]);
    updateWorkspace(db, item.id, { status: 'removed' }, 3);
    db.delete(jobs).run();
    expect(() => removeWorkspace(db, item.id)).toThrow(/no workspace/);
    expect(getItem(db, item.id)?.id).toBe(item.id);
  });
});
```

`src/core/work/gc.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { jobs } from '@/core/db/schema';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { enqueueWorkspaceGc } from './gc';
import { createWorkspaceRow, updateWorkspace } from './workspaces';

const DAY = 86_400_000;

describe('enqueueWorkspaceGc', () => {
  it('removes workspaces of items done or dismissed for longer than the retention', () => {
    const db = createTestDb();
    const oldDone = seedItem(db, { category: 'done', updatedAt: 0 });
    const recentDone = seedItem(db, { category: 'done', updatedAt: 9 * DAY });
    const active = seedItem(db, { category: 'in_progress', updatedAt: 0 });
    const removed = seedItem(db, { category: 'dismissed', updatedAt: 0 });
    for (const item of [oldDone, recentDone, active, removed]) {
      createWorkspaceRow(db, { itemId: item.id, container: `wf-${item.id}`, volume: `wf-${item.id}`, image: 'img' }, 0);
    }
    updateWorkspace(db, removed.id, { status: 'removed' }, 0);

    expect(enqueueWorkspaceGc(db, 7, 10 * DAY)).toBe(1);
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'remove-workspace', itemId: oldDone.id }]);
    expect(enqueueWorkspaceGc(db, 7, 10 * DAY)).toBe(0);
  });
});
```

`src/core/repos/current.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ActionError } from '@/core/errors';
import { knownRepoKeys, loadCurrentRepoMap } from './current';

describe('current repo map', () => {
  it('reports a missing map as an ActionError and an empty key list', () => {
    const before = process.env.WORKFLOW_CONFIG;
    process.env.WORKFLOW_CONFIG = '/nonexistent/workflow.config.yaml';
    try {
      expect(() => loadCurrentRepoMap()).toThrow(ActionError);
      expect(knownRepoKeys()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.WORKFLOW_CONFIG;
      else process.env.WORKFLOW_CONFIG = before;
    }
  });
});
```

Add to `src/core/ingest.test.ts`:
```ts
describe('start-investigation rule', () => {
  const investigateRules: Rule[] = [
    { when: { source: 'linear', label: 'ready-to-investigate' }, category: 'triage', action: 'start-investigation' },
  ];
  const labeled = (issueId = 'i5'): LinearLabelEvent => ({
    source: 'linear',
    kind: 'label_added',
    label: 'ready-to-investigate',
    issue: { id: issueId, identifier: 'BOO-5', title: 'Bug', url: 'u' },
  });

  it('starts an investigation once for a new Linear item', () => {
    const result = ingestEvent(db, labeled(), 'linear:i5:label:ready-to-investigate:t1', investigateRules, 10);
    expect(result.item).toMatchObject({ workState: 'investigating' });
    ingestEvent(db, labeled(), 'linear:i5:label:ready-to-investigate:t2', investigateRules, 20);
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'investigate' }]);
  });
});
```
(add `LinearLabelEvent` to the `@/core/events` import in that file).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/actions/work.test.ts src/core/work/gc.test.ts src/core/repos/current.test.ts src/core/ingest.test.ts`
Expected: FAIL, because the modules are missing and ingest ignores the action.

- [ ] **Step 3: Implement `src/core/actions/work.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { Item, JobType, Plan } from '../db/schema';
import { writeTransaction } from '../db/tx';
import { ActionError } from '../errors';
import { logActivity, updateItem } from '../items';
import { enqueueJob, latestFailedJob, requestStop, requeueJob, runningAgentJob } from '../jobs/queue';
import { type RepoMap, validateBreakdown } from '../repos/map';
import { getPlannedPr, updatePlannedPr } from '../work/planned-prs';
import { cleanPlanContent, latestPlan, type PlanContent, savePlan } from '../work/plans';
import { applyWorkEvent } from '../work/state';
import { getWorkspace } from '../work/workspaces';
import { assertNoActiveJob, requireActiveItem } from './guards';

const WORK_JOB_TYPES: readonly JobType[] = ['investigate', 'post-plan', 'implement-pr'];

export function startInvestigation(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (!item.linearIssueId) throw new ActionError(`Item #${itemId} has no Linear issue yet`);
    assertNoActiveJob(tx, itemId);
    const updated = applyWorkEvent(tx, itemId, { type: 'start' }, now);
    enqueueJob(tx, 'investigate', itemId, {}, now);
    logActivity(tx, itemId, 'Investigation started', now);
    return updated;
  });
}

function assertValidPlan(content: PlanContent, map: RepoMap): void {
  if (!content.body) throw new ActionError('The plan body cannot be empty');
  const error = validateBreakdown(content.breakdown, map);
  if (error) throw new ActionError(error);
}

export function editPlan(db: Db, itemId: number, content: PlanContent, map: RepoMap, now = Date.now()): Plan {
  const clean = cleanPlanContent(content);
  assertValidPlan(clean, map);
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    applyWorkEvent(tx, itemId, { type: 'user_edited' }, now);
    const plan = savePlan(tx, itemId, clean, 'user', null, now);
    logActivity(tx, itemId, `Plan v${plan.version} edited`, now);
    return plan;
  });
}

export function revisePlan(db: Db, itemId: number, feedback: string, now = Date.now()): Item {
  const trimmed = feedback.trim();
  if (!trimmed) throw new ActionError('Revision feedback cannot be empty');
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    assertNoActiveJob(tx, itemId);
    const item = applyWorkEvent(tx, itemId, { type: 'revise_requested' }, now);
    enqueueJob(tx, 'investigate', itemId, { feedback: trimmed }, now);
    logActivity(tx, itemId, `Plan revision requested: ${trimmed}`, now);
    return item;
  });
}

export function approvePlan(db: Db, itemId: number, map: RepoMap, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    requireActiveItem(tx, itemId);
    const plan = latestPlan(tx, itemId);
    if (!plan) throw new ActionError(`Item #${itemId} has no plan to approve`);
    assertValidPlan(plan, map);
    assertNoActiveJob(tx, itemId);
    const item = applyWorkEvent(tx, itemId, { type: 'approved' }, now);
    enqueueJob(tx, 'post-plan', itemId, { commentUuid: randomUUID() }, now);
    logActivity(tx, itemId, `Plan v${plan.version} approved, posting to Linear`, now);
    return item;
  });
}

export function retryWork(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (item.workState !== 'failed') throw new ActionError(`Item #${itemId} work has not failed`);
    const job = latestFailedJob(tx, itemId, WORK_JOB_TYPES);
    if (!job) throw new ActionError(`Item #${itemId} has no failed work job to retry`);
    if (job.type === 'implement-pr') {
      const { plannedPrId } = job.payload as { plannedPrId: number };
      updatePlannedPr(tx, plannedPrId, { state: 'pending', lastError: null }, now);
    }
    applyWorkEvent(tx, itemId, { type: 'retry', to: item.workFailedFromState ?? 'investigating' }, now);
    requeueJob(tx, job.id, now);
    logActivity(tx, itemId, `Retrying ${job.type}`, now);
    return updateItem(tx, itemId, { workFailedFromState: null, lastError: null }, now);
  });
}

export function fixPr(db: Db, itemId: number, plannedPrId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    if (item.workState !== 'implementing' && item.workState !== 'prs_open') {
      throw new ActionError(`Item #${itemId} has no open PRs to fix`);
    }
    const pr = getPlannedPr(tx, plannedPrId);
    if (!pr || pr.itemId !== itemId) throw new ActionError(`PR #${plannedPrId} is not part of item #${itemId}`);
    if (pr.state !== 'open' || !pr.prNumber) throw new ActionError(`PR ${pr.position} is not open yet`);
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'fix-pr', itemId, { plannedPrId }, now);
    logActivity(tx, itemId, `Fix round requested for ${pr.githubRepo}#${pr.prNumber}`, now);
    return item;
  });
}

export function stopRun(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    const job = runningAgentJob(tx, itemId);
    if (!job) throw new ActionError(`No agent run is active for item #${itemId}`);
    requestStop(tx, job.id);
    logActivity(tx, itemId, `Stop requested for ${job.type}`, now);
    return item;
  });
}

export function removeWorkspace(db: Db, itemId: number, now = Date.now()): Item {
  return writeTransaction(db, (tx) => {
    const item = requireActiveItem(tx, itemId);
    const ws = getWorkspace(tx, itemId);
    if (!ws || ws.status === 'removed') throw new ActionError(`Item #${itemId} has no workspace`);
    assertNoActiveJob(tx, itemId);
    enqueueJob(tx, 'remove-workspace', itemId, {}, now);
    logActivity(tx, itemId, 'Workspace removal requested', now);
    return item;
  });
}

```

`requireActiveItem` refuses dismissed items. That covers `removeWorkspace` on dismissed items too. GC removes their workspaces automatically, and you can move the item back first if you want it removed sooner.

- [ ] **Step 4: Export the actions**

Append to `src/core/actions/index.ts`:
```ts
export { approvePlan, editPlan, fixPr, removeWorkspace, retryWork, revisePlan, startInvestigation, stopRun } from './work';
```

- [ ] **Step 5: Implement `src/core/repos/current.ts`**

```ts
import { configPath, loadConfigFile } from '../config/load';
import { ActionError, errorMessage } from '../errors';
import { expandHome } from '../paths';
import { loadRepoMap, type RepoMap } from './map';

/** The repo map named by the current config. Used by the web app and CLI (a local file read only). */
export function loadCurrentRepoMap(): RepoMap {
  const result = loadConfigFile(configPath());
  if (!result.ok) throw new ActionError(result.error);
  try {
    return loadRepoMap(expandHome(result.config.agent.meetingpackageSkillDir));
  } catch (err) {
    throw new ActionError(errorMessage(err));
  }
}

export function knownRepoKeys(): string[] {
  try {
    return loadCurrentRepoMap().repos.map((r) => r.key);
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Implement `src/core/work/gc.ts`**

```ts
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { items, workspaces } from '../db/schema';
import { writeTransaction } from '../db/tx';
import { enqueueJob, hasActiveJob } from '../jobs/queue';

const DAY_MS = 86_400_000;

/** Enqueues `remove-workspace` for items done or dismissed for longer than the retention. Returns how many. */
export function enqueueWorkspaceGc(db: Db, retentionDays: number, now = Date.now()): number {
  return writeTransaction(db, (tx) => {
    const rows = tx
      .select({ itemId: workspaces.itemId })
      .from(workspaces)
      .innerJoin(items, eq(items.id, workspaces.itemId))
      .where(
        and(
          ne(workspaces.status, 'removed'),
          inArray(items.category, ['done', 'dismissed']),
          lt(items.updatedAt, now - retentionDays * DAY_MS),
        ),
      )
      .all();
    let queued = 0;
    for (const { itemId } of rows) {
      if (hasActiveJob(tx, itemId)) continue;
      enqueueJob(tx, 'remove-workspace', itemId, {}, now);
      queued++;
    }
    return queued;
  });
}
```

- [ ] **Step 7: Extend `src/core/jobs/rearm.ts`**

Add these imports:
```ts
import { type WorkState } from '../db/schema';
import { firstUnfinishedPr, updatePlannedPr } from '../work/planned-prs';
```
and replace `rearmStrandedJob` with:
```ts
const JOB_FOR_WORK_STATE: Partial<Record<WorkState, JobType>> = {
  investigating: 'investigate',
  posting_plan: 'post-plan',
  implementing: 'implement-pr',
};

/**
 * Handlers skip dismissed items, so an item dismissed in a job-driven state is left with no job.
 * When it comes back, enqueue the job for its state again. The previous job's payload is reused,
 * so a create job keeps its issue UUID, a post-plan job its comment UUID, and a draft or
 * investigate job its feedback.
 */
export function rearmStrandedJob(db: Db, item: Item, now = Date.now()): Job | null {
  if (hasActiveJob(db, item.id)) return null;
  const triageType = item.triageState ? JOB_FOR_STATE[item.triageState] : undefined;
  if (triageType) {
    const previous = latestJobOfType(db, item.id, triageType)?.payload as Record<string, unknown> | undefined;
    if (triageType === 'create-linear-issue') {
      const issueUuid = typeof previous?.issueUuid === 'string' ? previous.issueUuid : randomUUID();
      return enqueueJob(db, triageType, item.id, { issueUuid }, now);
    }
    return enqueueJob(db, triageType, item.id, (previous ?? {}) as JobPayloads[typeof triageType], now);
  }
  const workType = item.workState ? JOB_FOR_WORK_STATE[item.workState] : undefined;
  if (!workType) return null;
  if (workType === 'implement-pr') {
    const pr = firstUnfinishedPr(db, item.id);
    if (!pr) return null;
    if (pr.state !== 'pending') updatePlannedPr(db, pr.id, { state: 'pending' }, now);
    return enqueueJob(db, 'implement-pr', item.id, { plannedPrId: pr.id }, now);
  }
  const previous = latestJobOfType(db, item.id, workType)?.payload as Record<string, unknown> | undefined;
  if (workType === 'post-plan') {
    const commentUuid = typeof previous?.commentUuid === 'string' ? previous.commentUuid : randomUUID();
    return enqueueJob(db, 'post-plan', item.id, { commentUuid }, now);
  }
  return enqueueJob(db, 'investigate', item.id, (previous ?? {}) as JobPayloads['investigate'], now);
}
```

- [ ] **Step 8: Handle the rule action in `src/core/ingest.ts`**

Add `hasActiveJob` to the `./jobs/queue` import. In `applyRuleMatch`, replace the `if (match.action === 'triage-draft' …) … else if (before?.category …)` block with:
```ts
  if (match.action === 'triage-draft' && item.triageState === null) {
    updateItem(db, item.id, { triageState: 'new' }, now);
    enqueueJob(db, 'triage-draft', item.id, {}, now);
  } else if (
    match.action === 'start-investigation' &&
    item.workState === null &&
    item.linearIssueId &&
    item.category !== 'dismissed' &&
    !hasActiveJob(db, item.id)
  ) {
    updateItem(db, item.id, { workState: 'investigating' }, now);
    enqueueJob(db, 'investigate', item.id, {}, now);
    logActivity(db, item.id, 'Investigation started by rule', now);
  } else if (before?.category === 'dismissed' && item.category !== 'dismissed') {
    const job = rearmStrandedJob(db, item, now);
    if (job) logActivity(db, item.id, `Resuming ${job.type}`, now);
  }
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/core/actions src/core/repos/current.ts src/core/repos/current.test.ts src/core/work/gc.ts src/core/work/gc.test.ts src/core/jobs/rearm.ts src/core/ingest.ts src/core/ingest.test.ts
git commit -m "feat: add work actions, workspace GC and start-investigation rule" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 5: Process runner, container engine and agent image

**Files:**
- Create: `src/worker/agent/process.ts`, `src/worker/agent/engine.ts`, `src/test/fake-engine.ts`, `containers/agent/Containerfile`, `vitest.podman.config.ts`, `src/worker/agent/engine.podman.test.ts`
- Modify: `vitest.config.ts`, `package.json`
- Test: `src/worker/agent/process.test.ts`, `src/worker/agent/engine.test.ts`

**Interfaces:**
- Produces:
  - `process.ts`:
    - `ProcessResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }`
    - `ProcessOptions = { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number; signal?: AbortSignal; onLine?: (line: string) => void; cwd?: string }`
    - `Runner = (cmd: string, args: string[], opts?: ProcessOptions) => Promise<ProcessResult>`
    - `runProcess: Runner`, `KILL_GRACE_MS = 10_000`
  - `engine.ts`:
    - `ExecRequest = { container: string; workdir?: string; env?: Record<string, string>; args: string[]; stdin?: string; timeoutMs?: number; signal?: AbortSignal; onLine?: (line: string) => void }`
    - `interface ContainerEngine`:
      - `imageExists(image): Promise<boolean>`
      - `buildImage(image, contextDir): Promise<void>`
      - `ensureContainer(name, image): Promise<{ created: boolean }>`
      - `exec(req): Promise<ProcessResult>`
      - `copyInto(container, hostPath, containerPath): Promise<void>`
      - `remove(name): Promise<void>`
    - `execArgs(req): string[]`, `class PodmanEngine implements ContainerEngine` (`constructor(cmd = 'podman', run: Runner = runProcess)`)
  - `src/test/fake-engine.ts`:
    - `class FakeEngine implements ContainerEngine`, with these public fields:
      - `images: Set<string>`, `containers: Set<string>`, `dirs: Set<string>`
      - `built: string[]`, `removed: string[]`
      - `copies: { container; hostPath; containerPath }[]`, `execs: ExecRequest[]`
    - Methods:
      - `on(match: (req) => boolean, reply: FakeReply): this`
      - `replyClaude(...outputs: unknown[]): this` (each output is wrapped as a successful stream with session `s-N`)
    - Helpers:
      - `type FakeReply = { exitCode?: number; lines?: string[]; stderr?: string; timedOut?: boolean; aborted?: boolean }`
      - `claudeStream(output: unknown, sessionId?: string): string[]`
      - `isClaudeExec(req): boolean`

- [ ] **Step 1: Write the failing tests**

`src/worker/agent/process.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runProcess } from './process';

const node = process.execPath;

describe('runProcess', () => {
  it('streams stdout lines, captures stderr and exit code, and passes env and stdin', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      node,
      ['-e', 'process.stdin.on("data",d=>{console.log("a");console.log(process.env.SECRET+":"+d);console.error("warn");process.exit(3)})'],
      { env: { SECRET: 's3' }, stdin: 'in', onLine: (l) => lines.push(l) },
    );
    expect(lines).toEqual(['a', 's3:in']);
    expect(result).toMatchObject({ exitCode: 3, stderr: 'warn\n', timedOut: false, aborted: false });
  });

  it('kills on timeout and on abort', async () => {
    const slow = ['-e', 'setTimeout(()=>{},60000)'];
    await expect(runProcess(node, slow, { timeoutMs: 100 })).resolves.toMatchObject({ timedOut: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(runProcess(node, slow, { signal: controller.signal })).resolves.toMatchObject({ aborted: true });
  });

  it('rejects with a TransientError when the command cannot start', async () => {
    await expect(runProcess('/nonexistent/binary', [])).rejects.toThrow(/Could not start/);
  });
});
```

`src/worker/agent/engine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TransientError } from '@/core/errors';
import { execArgs, PodmanEngine } from './engine';
import type { ProcessOptions, ProcessResult } from './process';

const ok = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false });
const fail = (stderr = 'nope'): ProcessResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false, aborted: false });

function scripted(replies: Record<string, ProcessResult>) {
  const calls: { args: string[]; opts?: ProcessOptions }[] = [];
  const run = async (_cmd: string, args: string[], opts?: ProcessOptions) => {
    calls.push({ args, opts });
    return replies[args.slice(0, 2).join(' ')] ?? replies[args[0]!] ?? ok();
  };
  return { calls, run };
}

describe('execArgs', () => {
  it('passes env by name only, never values', () => {
    const args = execArgs({ container: 'wf-boo-1', workdir: '/work', env: { GH_TOKEN: 'secret-value' }, args: ['git', 'status'] });
    expect(args).toEqual(['exec', '-i', '-w', '/work', '--env', 'GH_TOKEN', 'wf-boo-1', 'git', 'status']);
    expect(args.join(' ')).not.toContain('secret-value');
  });
});

describe('PodmanEngine', () => {
  it('creates the volume and container when missing', async () => {
    const { calls, run } = scripted({ 'volume exists': fail(), 'container exists': fail() });
    const engine = new PodmanEngine('podman', run);
    await expect(engine.ensureContainer('wf-boo-1', 'img')).resolves.toEqual({ created: true });
    expect(calls.map((c) => c.args)).toEqual([
      ['volume', 'exists', 'wf-boo-1'],
      ['volume', 'create', 'wf-boo-1'],
      ['container', 'exists', 'wf-boo-1'],
      ['run', '-d', '--name', 'wf-boo-1', '--userns=keep-id', '-v', 'wf-boo-1:/work', 'img', 'sleep', 'infinity'],
    ]);
  });

  it('starts an existing stopped container', async () => {
    const { calls, run } = scripted({ inspect: ok('false\n') });
    const engine = new PodmanEngine('podman', run);
    await expect(engine.ensureContainer('wf-boo-1', 'img')).resolves.toEqual({ created: false });
    expect(calls.at(-1)?.args).toEqual(['start', 'wf-boo-1']);
  });

  it('passes exec env through the child environment and maps failures to TransientError', async () => {
    const { calls, run } = scripted({ 'cp /tmp/x': fail('no such container') });
    const engine = new PodmanEngine('podman', run);
    await engine.exec({ container: 'c', env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, args: ['claude', '--version'] });
    expect(calls[0]?.opts?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
    await expect(engine.copyInto('c', '/tmp/x', '/work/x')).rejects.toBeInstanceOf(TransientError);
  });
});
```
For the last case, `scripted` keys on `args.slice(0, 2)`, which is `cp /tmp/x` here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/worker/agent`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement `src/worker/agent/process.ts`**

```ts
import { spawn } from 'node:child_process';
import { TransientError } from '@/core/errors';

export type ProcessResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };
export type ProcessOptions = {
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  cwd?: string;
};
export type Runner = (cmd: string, args: string[], opts?: ProcessOptions) => Promise<ProcessResult>;

export const KILL_GRACE_MS = 10_000;

/** Runs a host process. Secrets go in `env` (merged over process.env), never in `args`. */
export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!opts.onLine) return;
      pending += text;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line) opts.onLine(line);
        index = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      cleanup();
      reject(new TransientError(`Could not start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      cleanup();
      if (opts.onLine && pending) opts.onLine(pending);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, aborted });
    });
    child.stdin.on('error', () => {
      // The child may exit before reading stdin; that is not an error for us.
    });
    child.stdin.end(opts.stdin ?? '');
  });
```

- [ ] **Step 4: Implement `src/worker/agent/engine.ts`**

```ts
import { TransientError } from '@/core/errors';
import { type ProcessOptions, type ProcessResult, type Runner, runProcess } from './process';

export type ExecRequest = {
  container: string;
  workdir?: string;
  /** Passed as `--env NAME`; the value travels in the podman process environment, never in argv. */
  env?: Record<string, string>;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
};

export interface ContainerEngine {
  imageExists(image: string): Promise<boolean>;
  buildImage(image: string, contextDir: string): Promise<void>;
  /** Creates the named volume and container if missing, starts it if stopped. */
  ensureContainer(name: string, image: string): Promise<{ created: boolean }>;
  exec(req: ExecRequest): Promise<ProcessResult>;
  copyInto(container: string, hostPath: string, containerPath: string): Promise<void>;
  /** Removes the container and its volume. Missing ones are ignored. */
  remove(name: string): Promise<void>;
}

export function execArgs(req: ExecRequest): string[] {
  const args = ['exec', '-i'];
  if (req.workdir) args.push('-w', req.workdir);
  for (const key of Object.keys(req.env ?? {})) args.push('--env', key);
  return [...args, req.container, ...req.args];
}

export class PodmanEngine implements ContainerEngine {
  constructor(
    private readonly cmd = 'podman',
    private readonly run: Runner = runProcess,
  ) {}

  private async must(args: string[], opts?: ProcessOptions): Promise<ProcessResult> {
    const result = await this.run(this.cmd, args, opts);
    if (result.exitCode !== 0) {
      throw new TransientError(`${this.cmd} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  }

  async imageExists(image: string): Promise<boolean> {
    return (await this.run(this.cmd, ['image', 'exists', image])).exitCode === 0;
  }

  async buildImage(image: string, contextDir: string): Promise<void> {
    await this.must(['build', '-t', image, contextDir], { timeoutMs: 30 * 60_000 });
  }

  async ensureContainer(name: string, image: string): Promise<{ created: boolean }> {
    if ((await this.run(this.cmd, ['volume', 'exists', name])).exitCode !== 0) await this.must(['volume', 'create', name]);
    if ((await this.run(this.cmd, ['container', 'exists', name])).exitCode !== 0) {
      await this.must(['run', '-d', '--name', name, '--userns=keep-id', '-v', `${name}:/work`, image, 'sleep', 'infinity']);
      return { created: true };
    }
    const state = await this.must(['inspect', '-f', '{{.State.Running}}', name]);
    if (state.stdout.trim() !== 'true') await this.must(['start', name]);
    return { created: false };
  }

  exec(req: ExecRequest): Promise<ProcessResult> {
    return this.run(this.cmd, execArgs(req), {
      env: req.env,
      stdin: req.stdin,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: req.onLine,
    });
  }

  async copyInto(container: string, hostPath: string, containerPath: string): Promise<void> {
    await this.must(['cp', hostPath, `${container}:${containerPath}`]);
  }

  async remove(name: string): Promise<void> {
    await this.run(this.cmd, ['rm', '-f', name]);
    await this.run(this.cmd, ['volume', 'rm', '-f', name]);
  }
}
```

- [ ] **Step 5: Implement `src/test/fake-engine.ts`**

```ts
import type { ContainerEngine, ExecRequest } from '@/worker/agent/engine';
import type { ProcessResult } from '@/worker/agent/process';

export type FakeReply = { exitCode?: number; lines?: string[]; stderr?: string; timedOut?: boolean; aborted?: boolean };

export function isClaudeExec(req: ExecRequest): boolean {
  return req.args.includes('claude');
}

/** A successful `claude -p --output-format stream-json` transcript whose final result is `output` as JSON. */
export function claudeStream(output: unknown, sessionId = 's-1'): string[] {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }),
  ];
}

export class FakeEngine implements ContainerEngine {
  images = new Set<string>();
  containers = new Set<string>();
  /** Paths that `test -d <path>` reports as existing. `git clone <url> <dest>` adds `<dest>/.git`. */
  dirs = new Set<string>();
  built: string[] = [];
  removed: string[] = [];
  copies: { container: string; hostPath: string; containerPath: string }[] = [];
  execs: ExecRequest[] = [];
  private rules: { match: (req: ExecRequest) => boolean; reply: FakeReply; once: boolean }[] = [];
  private claudeQueue: FakeReply[] = [];
  private sessions = 0;

  on(match: (req: ExecRequest) => boolean, reply: FakeReply, once = false): this {
    this.rules.push({ match, reply, once });
    return this;
  }

  replyClaude(...outputs: (unknown | FakeReply)[]): this {
    for (const output of outputs) {
      const isReply = typeof output === 'object' && output !== null && ('lines' in output || 'exitCode' in output || 'timedOut' in output || 'aborted' in output);
      this.claudeQueue.push(isReply ? (output as FakeReply) : { lines: claudeStream(output, `s-${++this.sessions}`) });
    }
    return this;
  }

  async imageExists(image: string) {
    return this.images.has(image);
  }

  async buildImage(image: string) {
    this.built.push(image);
    this.images.add(image);
  }

  async ensureContainer(name: string) {
    const created = !this.containers.has(name);
    this.containers.add(name);
    return { created };
  }

  async exec(req: ExecRequest): Promise<ProcessResult> {
    this.execs.push(req);
    const index = this.rules.findIndex((r) => r.match(req));
    let reply: FakeReply | undefined;
    if (index >= 0) {
      reply = this.rules[index]!.reply;
      if (this.rules[index]!.once) this.rules.splice(index, 1);
    } else if (isClaudeExec(req) && this.claudeQueue.length > 0) {
      reply = this.claudeQueue.shift();
    } else if (req.args[0] === 'test' && req.args[1] === '-d') {
      reply = { exitCode: this.dirs.has(req.args[2]!) ? 0 : 1 };
    } else if (req.args[0] === 'git' && req.args[1] === 'clone') {
      this.dirs.add(`${req.args[3]}/.git`);
    }
    for (const line of reply?.lines ?? []) req.onLine?.(line);
    return {
      exitCode: reply?.exitCode ?? 0,
      stdout: (reply?.lines ?? []).join('\n'),
      stderr: reply?.stderr ?? '',
      timedOut: reply?.timedOut ?? false,
      aborted: reply?.aborted ?? false,
    };
  }

  async copyInto(container: string, hostPath: string, containerPath: string) {
    this.copies.push({ container, hostPath, containerPath });
  }

  async remove(name: string) {
    this.removed.push(name);
    this.containers.delete(name);
  }
}
```

- [ ] **Step 6: Add the agent image `containers/agent/Containerfile`**

```dockerfile
FROM docker.io/library/node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq curl python3 build-essential ca-certificates gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code && corepack enable
RUN mkdir -p /work && chown node:node /work

USER node
ENV HOME=/home/node
RUN curl -fsSL https://mise.run | sh
ENV PATH=/home/node/.local/share/mise/shims:/home/node/.local/bin:$PATH
WORKDIR /work
```

- [ ] **Step 7: Wire the scripts and keep Podman tests out of `npm test`**

In `package.json` `scripts`, add:
```json
    "agent:build-image": "podman build -t workflow-agent:latest containers/agent",
    "test:podman": "vitest run --config vitest.podman.config.ts",
```

Replace `vitest.config.ts`:
```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.test.ts'], exclude: ['**/node_modules/**', 'src/**/*.podman.test.ts'], environment: 'node' },
});
```

Create `vitest.podman.config.ts`:
```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { include: ['src/**/*.podman.test.ts'], environment: 'node', testTimeout: 30 * 60_000, hookTimeout: 30 * 60_000 },
});
```

Create `src/worker/agent/engine.podman.test.ts`:
```ts
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PodmanEngine } from './engine';

const engine = new PodmanEngine('podman');
const name = `wf-podman-test-${process.pid}`;
const image = 'workflow-agent:latest';

describe('PodmanEngine (real podman)', () => {
  afterAll(async () => {
    await engine.remove(name);
  });

  it('builds the image if needed, runs claude in a fresh workspace and removes it', async () => {
    if (!(await engine.imageExists(image))) await engine.buildImage(image, path.resolve('containers/agent'));
    await expect(engine.ensureContainer(name, image)).resolves.toEqual({ created: true });
    const version = await engine.exec({ container: name, workdir: '/work', args: ['claude', '--version'] });
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/Claude Code/);
    const whoami = await engine.exec({ container: name, args: ['sh', '-c', 'id -u && echo $HOME && touch /work/ok && ls /work'] });
    expect(whoami.stdout).toContain('/home/node');
    expect(whoami.stdout).toContain('ok');
  });
});
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS (the Podman test is not collected); tsc clean.

Then run once: `npm run test:podman`
Expected: PASS. The first run builds the image, which can take several minutes. If the build fails because of network or registry access, record the exact error in your report and continue. It doesn't block `npm test`.

- [ ] **Step 9: Commit**

```bash
git add src/worker/agent/process.ts src/worker/agent/process.test.ts src/worker/agent/engine.ts src/worker/agent/engine.test.ts src/worker/agent/engine.podman.test.ts src/test/fake-engine.ts containers/agent/Containerfile vitest.config.ts vitest.podman.config.ts package.json
git commit -m "feat: add process runner, Podman container engine and agent image" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 6: GitHub client

**Files:**
- Create: `src/core/clients/github.ts`
- Modify: `src/core/clients/types.ts`, `src/test/fakes.ts`
- Test: `src/core/clients/github.test.ts`

**Interfaces:**
- Produces (in `types.ts`):
  - `PullRequestInfo = { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; merged: boolean; headRefName: string; headSha: string }`
  - `PrStatus = { isDraft: boolean; merged: boolean; state: string; unresolvedThreads: number; ciState: CiState }`
  - `ReviewThread = { id: string; path: string | null; line: number | null; comments: { author: string; body: string }[] }`
  - `FailingCheck = { name: string; summary: string; logTail: string }`
  - `PrRef = { repo: string; number: number }`
  - `interface GitHubClient`:
    - `viewer(): Promise<{ login: string }>`
    - `getPullRequest(repo, number): Promise<PullRequestInfo | null>`
    - `findOpenPrForBranch(repo, branch): Promise<PullRequestInfo | null>`
    - `prStatuses(prs: PrRef[]): Promise<Map<string, PrStatus>>`
    - `unresolvedThreads(repo, number): Promise<ReviewThread[]>`
    - `failingChecks(repo, number): Promise<FailingCheck[]>`
- Produces (in `github.ts`): `createGitHubClient(token: string, fetchImpl?: typeof fetch): GitHubClient`, `prKey(repo, number): string` (`"owner/name#12"`), `mapCiState(state: string | null | undefined): CiState`, `GITHUB_TIMEOUT_MS = 30_000`
- Produces (in `fakes.ts`): `class FakeGitHub implements GitHubClient`. Its public maps are `prs: Map<string, PullRequestInfo>` (by `prKey`), `branches: Map<string, PullRequestInfo>` (by `${repo}@${branch}`), `statuses: Map<string, PrStatus>`, `threads: Map<string, ReviewThread[]>` and `checks: Map<string, FailingCheck[]>`, plus `failures: Partial<Record<keyof GitHubClient, Error>>`.

- [ ] **Step 1: Add the types to `src/core/clients/types.ts`**

Append:
```ts
import type { CiState } from '../db/schema';

export type PrRef = { repo: string; number: number };
export type PullRequestInfo = {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  merged: boolean;
  headRefName: string;
  headSha: string;
};
export type PrStatus = { isDraft: boolean; merged: boolean; state: string; unresolvedThreads: number; ciState: CiState };
export type ReviewThread = { id: string; path: string | null; line: number | null; comments: { author: string; body: string }[] };
export type FailingCheck = { name: string; summary: string; logTail: string };

export interface GitHubClient {
  viewer(): Promise<{ login: string }>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo | null>;
  findOpenPrForBranch(repo: string, branch: string): Promise<PullRequestInfo | null>;
  /** Keyed by `prKey(repo, number)`. PRs that GitHub does not return are missing from the map. */
  prStatuses(prs: PrRef[]): Promise<Map<string, PrStatus>>;
  unresolvedThreads(repo: string, number: number): Promise<ReviewThread[]>;
  failingChecks(repo: string, number: number): Promise<FailingCheck[]>;
}
```
Move the new `import type { CiState }` line up to the top of the file, next to the existing imports.

- [ ] **Step 2: Write the failing test** `src/core/clients/github.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { PermanentError, TransientError } from '@/core/errors';
import { createGitHubClient, mapCiState, prKey } from './github';

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
function fakeFetch(...replies: Reply[]) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = replies.shift() ?? { body: {} };
    const payload = r.text ?? JSON.stringify(r.body ?? {});
    return new Response(payload, { status: r.status ?? 200, headers: r.headers });
  });
}
const client = (f: ReturnType<typeof fakeFetch>) => createGitHubClient('gh-token', f as unknown as typeof fetch);
const gqlBody = (f: ReturnType<typeof fakeFetch>, call = 0) => JSON.parse((f.mock.calls[call]![1] as RequestInit).body as string);

const prNode = { number: 12, url: 'https://github.com/acme/core/pull/12', state: 'OPEN', isDraft: true, merged: false, headRefName: 'boo-1-x', headRefOid: 'abc' };

describe('createGitHubClient', () => {
  it('sends the token and reads the viewer', async () => {
    const f = fakeFetch({ body: { data: { viewer: { login: 'arek' } } } });
    await expect(client(f).viewer()).resolves.toEqual({ login: 'arek' });
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer gh-token' });
  });

  it('maps a pull request and returns null when missing', async () => {
    const f = fakeFetch(
      { body: { data: { repository: { pullRequest: prNode } } } },
      { body: { data: { repository: { pullRequest: null } } } },
    );
    await expect(client(f).getPullRequest('acme/core', 12)).resolves.toEqual({
      number: 12,
      url: 'https://github.com/acme/core/pull/12',
      state: 'OPEN',
      isDraft: true,
      merged: false,
      headRefName: 'boo-1-x',
      headSha: 'abc',
    });
    expect(gqlBody(f).variables).toEqual({ owner: 'acme', name: 'core', number: 12 });
    await expect(client(f).getPullRequest('acme/core', 99)).resolves.toBeNull();
  });

  it('finds an open PR by branch', async () => {
    const f = fakeFetch({ body: { data: { repository: { pullRequests: { nodes: [prNode] } } } } }, { body: { data: { repository: { pullRequests: { nodes: [] } } } } });
    await expect(client(f).findOpenPrForBranch('acme/core', 'boo-1-x')).resolves.toMatchObject({ number: 12 });
    await expect(client(f).findOpenPrForBranch('acme/core', 'nope')).resolves.toBeNull();
  });

  it('batches PR statuses with aliases and counts unresolved threads', async () => {
    const node = (draft: boolean, rollup: string | null, resolved: boolean[]) => ({
      pullRequest: {
        isDraft: draft,
        merged: false,
        state: 'OPEN',
        reviewThreads: { nodes: resolved.map((isResolved) => ({ isResolved })) },
        commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
      },
    });
    const f = fakeFetch({ body: { data: { p0: node(true, 'SUCCESS', [true, false]), p1: node(false, null, []) } } });
    const result = await client(f).prStatuses([
      { repo: 'acme/core', number: 12 },
      { repo: 'acme/web', number: 3 },
    ]);
    expect(result.get(prKey('acme/core', 12))).toEqual({ isDraft: true, merged: false, state: 'OPEN', unresolvedThreads: 1, ciState: 'success' });
    expect(result.get(prKey('acme/web', 3))).toMatchObject({ ciState: 'none', unresolvedThreads: 0 });
    expect(gqlBody(f).query).toContain('p0: repository(owner: "acme", name: "core")');
  });

  it('returns only unresolved threads with their comments', async () => {
    const f = fakeFetch({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { id: 'T1', isResolved: false, path: 'src/a.ts', line: 4, comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'Handle null' }] } },
                  { id: 'T2', isResolved: true, path: 'src/b.ts', line: 1, comments: { nodes: [] } },
                ],
              },
            },
          },
        },
      },
    });
    await expect(client(f).unresolvedThreads('acme/core', 12)).resolves.toEqual([
      { id: 'T1', path: 'src/a.ts', line: 4, comments: [{ author: 'coderabbitai', body: 'Handle null' }] },
    ]);
  });

  it('collects failing checks with an Actions log tail', async () => {
    const log = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const f = fakeFetch(
      { body: { data: { repository: { pullRequest: prNode } } } },
      {
        body: {
          check_runs: [
            { id: 7, name: 'lint', conclusion: 'failure', app: { slug: 'github-actions' }, output: { title: 'Lint failed', summary: '2 errors' } },
            { id: 8, name: 'build', conclusion: 'success', app: { slug: 'github-actions' }, output: {} },
          ],
        },
      },
      { text: log },
    );
    const checks = await client(f).failingChecks('acme/core', 12);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'lint', summary: 'Lint failed — 2 errors' });
    expect(checks[0]!.logTail.split('\n')).toHaveLength(200);
    expect(f.mock.calls[1]![0]).toBe('https://api.github.com/repos/acme/core/commits/abc/check-runs?per_page=100');
    expect(f.mock.calls[2]![0]).toBe('https://api.github.com/repos/acme/core/actions/jobs/7/logs');
  });

  it('classifies errors', async () => {
    await expect(client(fakeFetch({ status: 401, body: { message: 'Bad credentials' } })).viewer()).rejects.toBeInstanceOf(PermanentError);
    await expect(client(fakeFetch({ status: 502 })).viewer()).rejects.toBeInstanceOf(TransientError);
    const limited = await client(
      fakeFetch({ status: 403, body: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } }),
    )
      .viewer()
      .catch((e) => e);
    expect(limited).toBeInstanceOf(TransientError);
    await expect(client(fakeFetch({ body: { errors: [{ message: 'Field x missing' }] } })).viewer()).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('mapCiState', () => {
  it('maps GitHub rollup states', () => {
    expect(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null].map(mapCiState)).toEqual([
      'success',
      'failure',
      'failure',
      'pending',
      'pending',
      'none',
    ]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/core/clients/github.test.ts`
Expected: FAIL, because `./github` can't be resolved.

- [ ] **Step 4: Implement `src/core/clients/github.ts`**

```ts
import type { CiState } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { FailingCheck, GitHubClient, PrStatus, PullRequestInfo, ReviewThread } from './types';

const API = 'https://api.github.com';
export const GITHUB_TIMEOUT_MS = 30_000;
const STATUS_BATCH = 20;
const PR_FIELDS = 'number url state isDraft merged headRefName headRefOid';

export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function mapCiState(state: string | null | undefined): CiState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new PermanentError(`Invalid GitHub repository "${repo}"`);
  return { owner, name };
}

type PrNode = { number: number; url: string; state: string; isDraft: boolean; merged: boolean; headRefName: string; headRefOid: string };

function toInfo(n: PrNode): PullRequestInfo {
  return {
    number: n.number,
    url: n.url,
    state: n.state as PullRequestInfo['state'],
    isDraft: n.isDraft,
    merged: n.merged,
    headRefName: n.headRefName,
    headSha: n.headRefOid,
  };
}

export function createGitHubClient(token: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'workflow', ...init.headers },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new TransientError(`GitHub request timed out after ${GITHUB_TIMEOUT_MS / 1000}s`);
      throw new TransientError(`GitHub request failed: ${errorMessage(err)}`);
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retryAfter = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
      throw new TransientError('GitHub rate limited', Math.min(retryAfter, 15 * 60_000));
    }
    if (res.status >= 500) throw new TransientError(`GitHub server error ${res.status}`);
    if (res.status === 401) throw new PermanentError('GitHub authentication failed (check GITHUB_TOKEN)');
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new PermanentError(`GitHub request failed with status ${res.status}: ${body.message ?? res.statusText}`);
    }
    return res;
  }

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await request(`${API}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string; type?: string }[] };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join('; ');
      if (body.errors.some((e) => e.type === 'RATE_LIMITED')) throw new TransientError(`GitHub rate limited: ${message}`, 60_000);
      throw new PermanentError(`GitHub API error: ${message}`);
    }
    if (!body.data) throw new PermanentError('GitHub returned no data');
    return body.data;
  }

  async function getPullRequest(repo: string, number: number): Promise<PullRequestInfo | null> {
    const { owner, name } = splitRepo(repo);
    const data = await gql<{ repository: { pullRequest: PrNode | null } | null }>(
      `query Pr($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
      { owner, name, number },
    );
    const node = data.repository?.pullRequest;
    return node ? toInfo(node) : null;
  }

  return {
    async viewer() {
      return (await gql<{ viewer: { login: string } }>('query { viewer { login } }')).viewer;
    },

    getPullRequest,

    async findOpenPrForBranch(repo, branch) {
      const { owner, name } = splitRepo(repo);
      const data = await gql<{ repository: { pullRequests: { nodes: PrNode[] } } | null }>(
        `query Branch($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, states: OPEN, first: 1) { nodes { ${PR_FIELDS} } } } }`,
        { owner, name, branch },
      );
      const node = data.repository?.pullRequests.nodes[0];
      return node ? toInfo(node) : null;
    },

    async prStatuses(prs) {
      const result = new Map<string, PrStatus>();
      for (let start = 0; start < prs.length; start += STATUS_BATCH) {
        const batch = prs.slice(start, start + STATUS_BATCH);
        const fields = batch
          .map((pr, i) => {
            const { owner, name } = splitRepo(pr.repo);
            return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(pr.number)}) { isDraft merged state reviewThreads(first: 100) { nodes { isResolved } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
          })
          .join('\n');
        type Node = {
          pullRequest: {
            isDraft: boolean;
            merged: boolean;
            state: string;
            reviewThreads: { nodes: { isResolved: boolean }[] };
            commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
          } | null;
        } | null;
        const data = await gql<Record<string, Node>>(`query Statuses {\n${fields}\n}`);
        batch.forEach((pr, i) => {
          const node = data[`p${i}`]?.pullRequest;
          if (!node) return;
          result.set(prKey(pr.repo, pr.number), {
            isDraft: node.isDraft,
            merged: node.merged,
            state: node.state,
            unresolvedThreads: node.reviewThreads.nodes.filter((t) => !t.isResolved).length,
            ciState: mapCiState(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
          });
        });
      }
      return result;
    },

    async unresolvedThreads(repo, number) {
      const { owner, name } = splitRepo(repo);
      type ThreadNode = {
        id: string;
        isResolved: boolean;
        path: string | null;
        line: number | null;
        comments: { nodes: { author: { login: string } | null; body: string }[] };
      };
      const data = await gql<{ repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[] } } | null } | null }>(
        `query Threads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 20) { nodes { author { login } body } } } } } } }`,
        { owner, name, number },
      );
      return (data.repository?.pullRequest?.reviewThreads.nodes ?? [])
        .filter((t) => !t.isResolved)
        .map(
          (t): ReviewThread => ({
            id: t.id,
            path: t.path,
            line: t.line,
            comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body })),
          }),
        );
    },

    async failingChecks(repo, number) {
      const pr = await getPullRequest(repo, number);
      if (!pr) throw new PermanentError(`PR ${repo}#${number} not found`);
      const res = await request(`${API}/repos/${repo}/commits/${pr.headSha}/check-runs?per_page=100`);
      const body = (await res.json()) as {
        check_runs: { id: number; name: string; conclusion: string | null; app?: { slug?: string }; output?: { title?: string | null; summary?: string | null } }[];
      };
      const failing = body.check_runs.filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'action_required');
      const checks: FailingCheck[] = [];
      for (const run of failing) {
        let logTail = '';
        if (run.app?.slug === 'github-actions') {
          try {
            const log = await (await request(`${API}/repos/${repo}/actions/jobs/${run.id}/logs`)).text();
            logTail = log.split('\n').slice(-200).join('\n');
          } catch {
            logTail = '';
          }
        }
        const summary = [run.output?.title, run.output?.summary].filter(Boolean).join(' — ');
        checks.push({ name: run.name, summary, logTail });
      }
      return checks;
    },
  };
}
```

- [ ] **Step 5: Add `FakeGitHub` to `src/test/fakes.ts`**

Add these imports (merge them into the existing type import from `@/core/clients/types`): `FailingCheck`, `GitHubClient`, `PrRef`, `PrStatus`, `PullRequestInfo`, `ReviewThread`. Then append:
```ts
export class FakeGitHub implements GitHubClient {
  prs = new Map<string, PullRequestInfo>();
  branches = new Map<string, PullRequestInfo>();
  statuses = new Map<string, PrStatus>();
  threads = new Map<string, ReviewThread[]>();
  checks = new Map<string, FailingCheck[]>();
  failures: Partial<Record<keyof GitHubClient, Error>> = {};
  statusCalls: PrRef[][] = [];

  private maybeFail(method: keyof GitHubClient): void {
    const err = this.failures[method];
    if (err) {
      delete this.failures[method];
      throw err;
    }
  }

  /** Registers an open PR as both found-by-number and found-by-branch. */
  addOpenPr(repo: string, number: number, branch: string): PullRequestInfo {
    const info: PullRequestInfo = {
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      state: 'OPEN',
      isDraft: true,
      merged: false,
      headRefName: branch,
      headSha: `sha-${number}`,
    };
    this.prs.set(`${repo}#${number}`, info);
    this.branches.set(`${repo}@${branch}`, info);
    return info;
  }

  async viewer() {
    this.maybeFail('viewer');
    return { login: 'me' };
  }

  async getPullRequest(repo: string, number: number) {
    this.maybeFail('getPullRequest');
    return this.prs.get(`${repo}#${number}`) ?? null;
  }

  async findOpenPrForBranch(repo: string, branch: string) {
    this.maybeFail('findOpenPrForBranch');
    return this.branches.get(`${repo}@${branch}`) ?? null;
  }

  async prStatuses(prs: PrRef[]) {
    this.maybeFail('prStatuses');
    this.statusCalls.push(prs);
    const result = new Map<string, PrStatus>();
    for (const pr of prs) {
      const status = this.statuses.get(`${pr.repo}#${pr.number}`);
      if (status) result.set(`${pr.repo}#${pr.number}`, status);
    }
    return result;
  }

  async unresolvedThreads(repo: string, number: number) {
    this.maybeFail('unresolvedThreads');
    return this.threads.get(`${repo}#${number}`) ?? [];
  }

  async failingChecks(repo: string, number: number) {
    this.maybeFail('failingChecks');
    return this.checks.get(`${repo}#${number}`) ?? [];
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/core/clients && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/clients/types.ts src/core/clients/github.ts src/core/clients/github.test.ts src/test/fakes.ts
git commit -m "feat: add GitHub client for PR verification, status and fix inputs" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 7: Linear client additions (comments, issue details, workflow state)

**Files:**
- Modify: `src/core/clients/types.ts`, `src/core/clients/linear.ts`, `src/test/fakes.ts`
- Test: `src/core/clients/linear.test.ts` (extend)

**Interfaces:**
- Produces on `LinearClient`:
  - `getIssueDetails(idOrIdentifier: string): Promise<LinearIssueDetails | null>`, where `LinearIssueDetails = LinearIssueRef & { description: string; comments: string[] }`
  - `commentExists(id: string): Promise<boolean>`
  - `createComment(input: { id: string; issueId: string; body: string }): Promise<void>`
  - `setIssueStateByName(issueId: string, stateName: string): Promise<void>` (throws `PermanentError` when the team has no state with that name)
- Produces on `FakeLinear`:
  - `details: Map<string, LinearIssueDetails>`
  - `comments: { id; issueId; body }[]`
  - `stateChanges: { issueId; stateName }[]`
  - `teamStates: string[]` (default `['Todo', 'In Progress', 'Done']`)
  - `loseNextCommentResponse: boolean`

- [ ] **Step 1: Add the types**

In `src/core/clients/types.ts`, add:
```ts
export type LinearIssueDetails = LinearIssueRef & { description: string; comments: string[] };
```
and add to the `LinearClient` interface:
```ts
  getIssueDetails(idOrIdentifier: string): Promise<LinearIssueDetails | null>;
  commentExists(id: string): Promise<boolean>;
  /** `id` is a client-generated UUID v4 that Linear uses as the comment id. */
  createComment(input: { id: string; issueId: string; body: string }): Promise<void>;
  setIssueStateByName(issueId: string, stateName: string): Promise<void>;
```

- [ ] **Step 2: Write the failing tests** (append to `src/core/clients/linear.test.ts`, reusing its `fakeFetch` and `bodyOf` helpers)

```ts
describe('plan comments and issue details', () => {
  it('reads issue details with description and comments', async () => {
    const fetchFn = fakeFetch({
      body: {
        data: {
          issue: {
            id: 'i1',
            identifier: 'BOO-1',
            title: 'Bug',
            url: 'u',
            description: null,
            comments: { nodes: [{ body: 'first' }, { body: 'second' }] },
          },
        },
      },
    });
    await expect(createLinearClient('key', fetchFn as unknown as typeof fetch).getIssueDetails('BOO-1')).resolves.toEqual({
      id: 'i1',
      identifier: 'BOO-1',
      title: 'Bug',
      url: 'u',
      description: '',
      comments: ['first', 'second'],
    });
  });

  it('checks for a comment by id and treats not-found as false', async () => {
    const fetchFn = fakeFetch(
      { body: { data: { comment: { id: 'c1' } } } },
      { status: 400, body: { errors: [{ message: 'Entity not found: Comment' }] } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await expect(client.commentExists('c1')).resolves.toBe(true);
    await expect(client.commentExists('c2')).resolves.toBe(false);
  });

  it('creates a comment with the client-supplied id', async () => {
    const fetchFn = fakeFetch({ body: { data: { commentCreate: { success: true } } } });
    await createLinearClient('key', fetchFn as unknown as typeof fetch).createComment({ id: 'c1', issueId: 'i1', body: 'plan' });
    expect(bodyOf(fetchFn).variables).toEqual({ input: { id: 'c1', issueId: 'i1', body: 'plan' } });
  });

  it('moves an issue to a workflow state by name, case-insensitively', async () => {
    const fetchFn = fakeFetch(
      { body: { data: { issue: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }, { id: 's2', name: 'In Progress' }] } } } } } },
      { body: { data: { issueUpdate: { success: true } } } },
      { body: { data: { issue: { team: { states: { nodes: [{ id: 's1', name: 'Todo' }] } } } } } },
    );
    const client = createLinearClient('key', fetchFn as unknown as typeof fetch);
    await client.setIssueStateByName('i1', 'in progress');
    expect(bodyOf(fetchFn, 1).variables).toEqual({ id: 'i1', input: { stateId: 's2' } });
    await expect(client.setIssueStateByName('i1', 'Shipped')).rejects.toThrow('Linear state "Shipped" not found');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/core/clients/linear.test.ts`
Expected: FAIL (`getIssueDetails is not a function`).

- [ ] **Step 4: Implement in `src/core/clients/linear.ts`**

Add these queries after the existing ones:
```ts
const ISSUE_DETAILS = `query IssueDetails($id: String!) { issue(id: $id) { ${ISSUE_REF} description comments(first: 20) { nodes { body } } } }`;
const COMMENT = `query Comment($id: String!) { comment(id: $id) { id } }`;
const CREATE_COMMENT = `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;
const ISSUE_STATES = `query IssueStates($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`;
const UPDATE_ISSUE = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
```
Add `LinearIssueDetails` to the type import from `./types`, and add these methods to the returned object:
```ts
    async getIssueDetails(idOrIdentifier) {
      try {
        const data = await gql<{
          issue: (LinearIssueRef & { description: string | null; comments: { nodes: { body: string }[] } }) | null;
        }>(ISSUE_DETAILS, { id: idOrIdentifier });
        const issue = data.issue;
        if (!issue) return null;
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          description: issue.description ?? '',
          comments: issue.comments.nodes.map((c) => c.body),
        } satisfies LinearIssueDetails;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return null;
        throw err;
      }
    },

    async commentExists(id) {
      try {
        return (await gql<{ comment: { id: string } | null }>(COMMENT, { id })).comment !== null;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return false;
        throw err;
      }
    },

    async createComment(input) {
      const data = await gql<{ commentCreate: { success: boolean } }>(CREATE_COMMENT, { input });
      if (!data.commentCreate.success) throw new PermanentError('Linear did not create the comment');
    },

    async setIssueStateByName(issueId, stateName) {
      const data = await gql<{ issue: { team: { states: { nodes: { id: string; name: string }[] } } } | null }>(ISSUE_STATES, { id: issueId });
      const state = data.issue?.team.states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
      if (!state) throw new PermanentError(`Linear state "${stateName}" not found`);
      const updated = await gql<{ issueUpdate: { success: boolean } }>(UPDATE_ISSUE, { id: issueId, input: { stateId: state.id } });
      if (!updated.issueUpdate.success) throw new PermanentError('Linear did not update the issue state');
    },
```

- [ ] **Step 5: Extend `FakeLinear` in `src/test/fakes.ts`**

Add `LinearIssueDetails` to the type import, and add these fields and methods to `FakeLinear`:
```ts
  details = new Map<string, LinearIssueDetails>();
  comments: { id: string; issueId: string; body: string }[] = [];
  stateChanges: { issueId: string; stateName: string }[] = [];
  teamStates = ['Todo', 'In Progress', 'Done'];
  loseNextCommentResponse = false;

  async getIssueDetails(idOrIdentifier: string) {
    this.maybeFail('getIssueDetails');
    return this.details.get(idOrIdentifier) ?? null;
  }

  async commentExists(id: string) {
    this.maybeFail('commentExists');
    return this.comments.some((c) => c.id === id);
  }

  async createComment(input: { id: string; issueId: string; body: string }) {
    this.maybeFail('createComment');
    if (this.comments.some((c) => c.id === input.id)) throw new PermanentError(`Linear API error: comment ${input.id} already exists`);
    this.comments.push(input);
    if (this.loseNextCommentResponse) {
      this.loseNextCommentResponse = false;
      throw new TransientError('timeout');
    }
  }

  async setIssueStateByName(issueId: string, stateName: string) {
    this.maybeFail('setIssueStateByName');
    if (!this.teamStates.some((s) => s.toLowerCase() === stateName.toLowerCase())) {
      throw new PermanentError(`Linear state "${stateName}" not found`);
    }
    this.stateChanges.push({ issueId, stateName });
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/clients/types.ts src/core/clients/linear.ts src/core/clients/linear.test.ts src/test/fakes.ts
git commit -m "feat: add Linear comment, issue details and workflow state calls" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 8: CodeArtifact tokens and host tools

**Files:**
- Create: `src/worker/agent/codeartifact.ts`, `src/worker/agent/host.ts`
- Modify: `src/test/fakes.ts` (add `FakeHost`)
- Test: `src/worker/agent/codeartifact.test.ts`, `src/worker/agent/host.test.ts`

**Interfaces:**
- Consumes: `Runner`, `ProcessResult`, `runProcess` (Task 5); `RepoDefaults` (Task 2).
- Produces:
  - `codeartifact.ts`:
    - `class CodeArtifactTokens { constructor(run: Runner, now?: () => number); token(profile: string, defaults: RepoDefaults): Promise<string> }`
    - `registryAuthKey(registry: string): string`
    - `withRegistryAuth(args: string[], registry: string): string[]`
  - `host.ts`:
    - `interface HostTools`:
      - `gitIdentity(): Promise<{ name: string; email: string }>`
      - `syncEnv(repoKey: string, envName: string): Promise<string | null>`
      - `detectRepository(issue: { identifier: string; title: string; description: string; comments: string[] }): Promise<string | null>`
    - `createHostTools(opts: { run: Runner; dockerSkillDir: string; meetingpackageSkillDir: string }): HostTools`
  - `fakes.ts`: `class FakeHost implements HostTools` with `identity`, `envDirs: Map<string, string>`, `detected: string | null` and `syncCalls: string[]`.

- [ ] **Step 1: Write the failing tests**

`src/worker/agent/codeartifact.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { CodeArtifactTokens, registryAuthKey, withRegistryAuth } from './codeartifact';
import { type ProcessResult, runProcess } from './process';

const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false });

describe('CodeArtifactTokens', () => {
  it('fetches a token on the host with the repo profile and caches it until near expiry', async () => {
    const calls: string[][] = [];
    let now = Date.parse('2026-10-15T10:00:00Z');
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return ok(JSON.stringify({ authorizationToken: `tok-${calls.length}`, expiration: '2026-10-15T22:00:00Z' }));
    };
    const tokens = new CodeArtifactTokens(run, () => now);
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-1');
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-1');
    expect(calls[0]).toEqual([
      'codeartifact',
      'get-authorization-token',
      '--domain',
      'acme-npm',
      '--domain-owner',
      '111122223333',
      '--region',
      'eu-west-2',
      '--profile',
      'core-artifactory',
      '--output',
      'json',
    ]);
    now = Date.parse('2026-10-15T21:45:00Z');
    await expect(tokens.token('core-artifactory', TEST_REPO_MAP.defaults)).resolves.toBe('tok-2');
  });

  it('fails permanently with an aws sso login hint', async () => {
    const run = async () => ({ exitCode: 255, stdout: '', stderr: 'Error when retrieving token from sso: Token has expired', timedOut: false, aborted: false });
    const err = await new CodeArtifactTokens(run).token('core-artifactory', TEST_REPO_MAP.defaults).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('Try: aws sso login --profile core-artifactory');
  });
});

describe('withRegistryAuth', () => {
  it('derives the npmrc auth key from the registry URL', () => {
    expect(registryAuthKey(TEST_REPO_MAP.defaults.codeArtifactRegistry)).toBe(
      '//acme-npm-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/acme-internal/',
    );
  });

  it('writes npmrc and yarnrc for the command and removes them afterwards', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ca-home-'));
    const out = path.join(home, 'seen.txt');
    const args = withRegistryAuth(['sh', '-c', `cat "$HOME/.npmrc" "$HOME/.yarnrc.yml" > ${out}`], TEST_REPO_MAP.defaults.codeArtifactRegistry);
    expect(args.join(' ')).not.toContain('secret-token');
    const result = await runProcess(args[0]!, args.slice(1), { env: { HOME: home, CODEARTIFACT_AUTH_TOKEN: 'secret-token' } });
    expect(result.exitCode).toBe(0);
    const seen = readFileSync(out, 'utf8');
    expect(seen).toContain('//acme-npm-111122223333.d.codeartifact.eu-west-2.amazonaws.com/npm/acme-internal/:_authToken=secret-token');
    expect(seen).toContain('npmAuthToken: "secret-token"');
    expect(seen).toContain('npmAlwaysAuth: true');
    expect(existsSync(path.join(home, '.npmrc'))).toBe(false);
    expect(existsSync(path.join(home, '.yarnrc.yml'))).toBe(false);
  });

  it('propagates the command exit code', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ca-home-'));
    const args = withRegistryAuth(['sh', '-c', 'exit 7'], TEST_REPO_MAP.defaults.codeArtifactRegistry);
    const result = await runProcess(args[0]!, args.slice(1), { env: { HOME: home, CODEARTIFACT_AUTH_TOKEN: 't' } });
    expect(result.exitCode).toBe(7);
    expect(existsSync(path.join(home, '.npmrc'))).toBe(false);
  });
});
```

`src/worker/agent/host.test.ts`:
```ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '@/core/errors';
import { createHostTools } from './host';
import type { ProcessOptions, ProcessResult } from './process';

const result = (exitCode: number, stdout = '', stderr = ''): ProcessResult => ({ exitCode, stdout, stderr, timedOut: false, aborted: false });

describe('createHostTools', () => {
  it('reads the host git identity', async () => {
    const run = async (_cmd: string, args: string[]) => result(0, args.includes('user.name') ? 'Arek Z\n' : 'arek@example.com\n');
    const host = createHostTools({ run, dockerSkillDir: '/d', meetingpackageSkillDir: '/m' });
    await expect(host.gitIdentity()).resolves.toEqual({ name: 'Arek Z', email: 'arek@example.com' });
    const missing = createHostTools({ run: async () => result(1), dockerSkillDir: '/d', meetingpackageSkillDir: '/m' });
    await expect(missing.gitIdentity()).rejects.toBeInstanceOf(PermanentError);
  });

  it('runs sync-env and returns the private env directory when it exists', async () => {
    const dockerSkillDir = mkdtempSync(path.join(tmpdir(), 'docker-skill-'));
    mkdirSync(path.join(dockerSkillDir, 'private', 'env', 'core', 'development'), { recursive: true });
    const calls: string[][] = [];
    const host = createHostTools({
      run: async (_cmd, args) => {
        calls.push(args);
        return result(0);
      },
      dockerSkillDir,
      meetingpackageSkillDir: '/m',
    });
    await expect(host.syncEnv('core', 'development')).resolves.toBe(path.join(dockerSkillDir, 'private', 'env', 'core', 'development'));
    expect(calls[0]).toEqual([path.join(dockerSkillDir, 'scripts', 'sync-env.sh'), '--repo', 'core', '--env', 'development']);
    await expect(host.syncEnv('web', 'development')).resolves.toBeNull();
  });

  it('detects a repository through the meetingpackage script, null when ambiguous', async () => {
    const seen: ProcessOptions[] = [];
    let code = 0;
    const host = createHostTools({
      run: async (_cmd, _args, opts) => {
        seen.push(opts ?? {});
        return result(code, code === 0 ? 'core\n' : '', code === 0 ? '' : 'ambiguous');
      },
      dockerSkillDir: '/d',
      meetingpackageSkillDir: '/m',
    });
    const issue = { identifier: 'BOO-1', title: 'core-api drops bodies', description: 'd', comments: ['c'] };
    await expect(host.detectRepository(issue)).resolves.toBe('core');
    expect(JSON.parse(seen[0]!.stdin!)).toEqual({ identifier: 'BOO-1', title: 'core-api drops bodies', description: 'd', comments: { nodes: [{ body: 'c' }] } });
    code = 1;
    await expect(host.detectRepository(issue)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/worker/agent/codeartifact.test.ts src/worker/agent/host.test.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement `src/worker/agent/codeartifact.ts`**

```ts
import type { RepoDefaults } from '@/core/repos/map';
import { PermanentError } from '@/core/errors';
import type { Runner } from './process';

const REFRESH_MARGIN_MS = 30 * 60_000;

/** Short-lived CodeArtifact npm tokens, fetched with the host AWS CLI and cached in memory. */
export class CodeArtifactTokens {
  private cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly run: Runner,
    private readonly now: () => number = Date.now,
  ) {}

  async token(profile: string, defaults: RepoDefaults): Promise<string> {
    const cached = this.cache.get(profile);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return cached.token;
    const result = await this.run(
      'aws',
      [
        'codeartifact',
        'get-authorization-token',
        '--domain',
        defaults.codeArtifactDomain,
        '--domain-owner',
        defaults.awsAccountId,
        '--region',
        defaults.awsRegion,
        '--profile',
        profile,
        '--output',
        'json',
      ],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new PermanentError(
        `AWS CodeArtifact token for profile ${profile} failed: ${(result.stderr || result.stdout).trim()}. Try: aws sso login --profile ${profile}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as { authorizationToken: string; expiration: string | number };
    const expiresAt = typeof parsed.expiration === 'number' ? parsed.expiration * 1000 : Date.parse(parsed.expiration);
    this.cache.set(profile, {
      token: parsed.authorizationToken,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 60 * 60_000,
    });
    return parsed.authorizationToken;
  }
}

export function registryAuthKey(registry: string): string {
  const url = new URL(registry);
  return `//${url.host}${url.pathname}`;
}

/**
 * Wraps a container command so it runs with ~/.npmrc and ~/.yarnrc.yml carrying
 * $CODEARTIFACT_AUTH_TOKEN (passed via `--env`), and removes both files when it exits.
 */
export function withRegistryAuth(args: string[], registry: string): string[] {
  const key = registryAuthKey(registry);
  const script = [
    `printf '%s:_authToken=%s\\n' '${key}' "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.npmrc"`,
    `printf 'npmRegistries:\\n  "%s":\\n    npmAuthToken: "%s"\\n    npmAlwaysAuth: true\\n' '${registry}' "$CODEARTIFACT_AUTH_TOKEN" > "$HOME/.yarnrc.yml"`,
    `trap 'rm -f "$HOME/.npmrc" "$HOME/.yarnrc.yml"' EXIT`,
    '"$@"',
  ].join('\n');
  return ['sh', '-c', script, 'sh', ...args];
}
```

- [ ] **Step 4: Implement `src/worker/agent/host.ts`**

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PermanentError } from '@/core/errors';
import type { Runner } from './process';

export interface HostTools {
  gitIdentity(): Promise<{ name: string; email: string }>;
  /** Runs the docker skill's sync-env.sh and returns the directory holding the env files, or null. Never reads them. */
  syncEnv(repoKey: string, envName: string): Promise<string | null>;
  detectRepository(issue: { identifier: string; title: string; description: string; comments: string[] }): Promise<string | null>;
}

export function createHostTools(opts: { run: Runner; dockerSkillDir: string; meetingpackageSkillDir: string }): HostTools {
  async function gitConfig(key: string): Promise<string> {
    const result = await opts.run('git', ['config', '--global', key]);
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || !value) throw new PermanentError(`Host git ${key} is not set. Run: git config --global ${key} "…"`);
    return value;
  }

  return {
    async gitIdentity() {
      return { name: await gitConfig('user.name'), email: await gitConfig('user.email') };
    },

    async syncEnv(repoKey, envName) {
      const script = path.join(opts.dockerSkillDir, 'scripts', 'sync-env.sh');
      const result = await opts.run('bash', [script, '--repo', repoKey, '--env', envName], { timeoutMs: 5 * 60_000 });
      if (result.exitCode !== 0) {
        throw new PermanentError(`sync-env.sh failed for ${repoKey}: ${(result.stderr || result.stdout).trim()}`);
      }
      const dir = path.join(opts.dockerSkillDir, 'private', 'env', repoKey, envName);
      return existsSync(dir) ? dir : null;
    },

    async detectRepository(issue) {
      const script = path.join(opts.meetingpackageSkillDir, 'scripts', 'detect-repository.sh');
      const payload = {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        comments: { nodes: issue.comments.map((body) => ({ body })) },
      };
      const result = await opts.run('bash', [script, '-'], { stdin: JSON.stringify(payload), timeoutMs: 60_000 });
      const key = result.stdout.trim();
      return result.exitCode === 0 && key ? key : null;
    },
  };
}
```

- [ ] **Step 5: Add `FakeHost` to `src/test/fakes.ts`**

```ts
import type { HostTools } from '@/worker/agent/host';

export class FakeHost implements HostTools {
  identity = { name: 'Arek Z', email: 'arek@example.com' };
  envDirs = new Map<string, string>();
  detected: string | null = 'core';
  syncCalls: string[] = [];
  detectCalls: unknown[] = [];

  async gitIdentity() {
    return this.identity;
  }

  async syncEnv(repoKey: string) {
    this.syncCalls.push(repoKey);
    return this.envDirs.get(repoKey) ?? null;
  }

  async detectRepository(issue: unknown) {
    this.detectCalls.push(issue);
    return this.detected;
  }
}
```
Put the import at the top of `fakes.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/worker/agent/codeartifact.ts src/worker/agent/codeartifact.test.ts src/worker/agent/host.ts src/worker/agent/host.test.ts src/test/fakes.ts
git commit -m "feat: add CodeArtifact token handling and host tool wrappers" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 9: Agent dependencies and the workspace manager

**Files:**
- Create: `src/worker/agent/deps.ts`, `src/worker/agent/workspace.ts`, `src/test/agent.ts`
- Test: `src/worker/agent/workspace.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7 and 8.
- Produces:
  - `deps.ts`:
    - `AgentDeps` has these fields:
      - core: `db: Db`, `config: Config`, `now: () => number`
      - clients: `engine: ContainerEngine`, `github: GitHubClient`, `linear: LinearClient`
      - repos and host: `repoMap: () => RepoMap`, `codeArtifact: CodeArtifactTokens`, `host: HostTools`
      - secrets and paths: `secrets: { claudeToken: string; ghToken: string }`, `skillDirs: { github: string; meetingpackage: string }`, `imageContextDir: string`, `runsDir: string`, `promptsDir: string`
    - `AgentHandler = (deps: AgentDeps, job: Job) => Promise<void>`
  - `workspace.ts`:
    - `ensureWorkspace(deps, item: Item, repoKeys: string[]): Promise<Workspace>`
    - `registryAuth(deps, repo: RepoEntry): Promise<{ registry: string; token: string } | null>`
    - `removeWorkspaceHandler: AgentHandler`
    - `CONTAINER_HOME = '/home/node'`
  - `src/test/agent.ts`: `makeAgentDeps(db: Db)`, which returns `{ deps: AgentDeps; engine: FakeEngine; github: FakeGitHub; linear: FakeLinear; host: FakeHost; awsCalls: string[][]; runsDir: string }`.

- [ ] **Step 1: Implement `src/worker/agent/deps.ts`**

```ts
import type { GitHubClient, LinearClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';
import type { RepoMap } from '@/core/repos/map';
import type { CodeArtifactTokens } from './codeartifact';
import type { ContainerEngine } from './engine';
import type { HostTools } from './host';

export type AgentDeps = {
  db: Db;
  config: Config;
  engine: ContainerEngine;
  github: GitHubClient;
  linear: LinearClient;
  repoMap: () => RepoMap;
  codeArtifact: CodeArtifactTokens;
  host: HostTools;
  secrets: { claudeToken: string; ghToken: string };
  skillDirs: { github: string; meetingpackage: string };
  imageContextDir: string;
  runsDir: string;
  promptsDir: string;
  now: () => number;
};

export type AgentHandler = (deps: AgentDeps, job: Job) => Promise<void>;
```

- [ ] **Step 2: Implement the test helper `src/test/agent.ts`**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '@/core/db/client';
import { CodeArtifactTokens } from '@/worker/agent/codeartifact';
import type { AgentDeps } from '@/worker/agent/deps';
import { FakeEngine } from './fake-engine';
import { FakeGitHub, FakeHost, FakeLinear, TEST_CONFIG } from './fakes';
import { TEST_REPO_MAP } from './repo-map';

export function makeAgentDeps(db: Db) {
  const engine = new FakeEngine();
  const github = new FakeGitHub();
  const linear = new FakeLinear();
  const host = new FakeHost();
  const awsCalls: string[][] = [];
  const codeArtifact = new CodeArtifactTokens(async (_cmd, args) => {
    awsCalls.push(args);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ authorizationToken: 'ca-token', expiration: '2999-01-01T00:00:00Z' }),
      stderr: '',
      timedOut: false,
      aborted: false,
    };
  });
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const deps: AgentDeps = {
    db,
    config: TEST_CONFIG,
    engine,
    github,
    linear,
    repoMap: () => TEST_REPO_MAP,
    codeArtifact,
    host,
    secrets: { claudeToken: 'claude-token', ghToken: 'gh-token' },
    skillDirs: { github: '/skills/github', meetingpackage: '/skills/meetingpackage' },
    imageContextDir: '/ctx',
    runsDir,
    promptsDir: path.join(process.cwd(), 'prompts'),
    now: () => 1_000,
  };
  return { deps, engine, github, linear, host, awsCalls, runsDir };
}
```

- [ ] **Step 3: Write the failing test** `src/worker/agent/workspace.test.ts`

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/worker/agent/workspace.test.ts`
Expected: FAIL, because `./workspace` is missing.

- [ ] **Step 5: Implement `src/worker/agent/workspace.ts`**

```ts
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
        `printf 'node %s\\n' '${repo.node}' > .tool-versions && (grep -qx '.tool-versions' .git/info/exclude || echo .tool-versions >> .git/info/exclude) && mise install`,
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
```
`prepareRepo` still checks the disk with `test -d` when a container was recreated over an existing volume, so a repo that's already there is reused instead of re-cloned.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/worker/agent/deps.ts src/worker/agent/workspace.ts src/worker/agent/workspace.test.ts src/test/agent.ts
git commit -m "feat: add per-item Podman workspace manager" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 10: Running Claude in the container (`runAgent`)

**Files:**
- Create: `src/worker/agent/run.ts`, `src/worker/agent/prompts.ts`
- Test: `src/worker/agent/run.test.ts`

**Interfaces:**
- Consumes: `AgentDeps` (Task 9), `startRun`/`finishRun` and `parseStreamLine` (Task 3), `isStopRequested` (Task 3), `withRegistryAuth` (Task 8), `extractJson` and `renderPrompt` (`src/core/clients/claude.ts`).
- Produces:
  - `run.ts`:
    - `INVESTIGATE_TOOLS: string`
    - `claudeArgs(kind: AgentRunKind, prompt: string, opts: { maxTurns: number; model: string | null; resume?: string }): string[]`
    - `AgentRunRequest<T> = { job: Job; item: Item; plannedPrId?: number | null; kind: AgentRunKind; prompt: string; schema: z.ZodType<T>; env: Record<string, string>; registry?: string | null }`
    - `runAgent<T>(deps: AgentDeps, req: AgentRunRequest<T>): Promise<T>`
  - `prompts.ts`: `AgentPromptName = 'agent-investigate' | 'agent-implement' | 'agent-fix'`, `renderAgentPrompt(promptsDir: string, name: AgentPromptName, vars: Record<string, string>): string`

- [ ] **Step 1: Write the failing test** `src/worker/agent/run.test.ts`

```ts
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { PermanentError, TransientError } from '@/core/errors';
import { claimNextJob, enqueueJob, requestStop } from '@/core/jobs/queue';
import { listRuns } from '@/core/work/runs';
import { createWorkspaceRow, getWorkspace } from '@/core/work/workspaces';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { claudeArgs, INVESTIGATE_TOOLS, runAgent } from './run';

const schema = z.object({ answer: z.number(), summary: z.string().optional() });
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(kind: 'investigate' | 'implement-pr' = 'investigate') {
  const env = makeAgentDeps(db);
  const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1' });
  createWorkspaceRow(db, { itemId: item.id, container: 'wf-boo-1', volume: 'wf-boo-1', image: 'img' }, 0);
  enqueueJob(db, kind === 'investigate' ? 'investigate' : 'implement-pr', item.id, kind === 'investigate' ? {} : { plannedPrId: 1 }, 0);
  const job = claimNextJob(db, 0)!;
  return { ...env, item, job };
}

describe('claudeArgs', () => {
  it('limits investigation to read-only tools and lets implementation run unattended', () => {
    expect(claudeArgs('investigate', 'P', { maxTurns: 60, model: null })).toEqual([
      'claude', '-p', 'P', '--output-format', 'stream-json', '--verbose', '--max-turns', '60', '--allowedTools', INVESTIGATE_TOOLS,
    ]);
    expect(claudeArgs('implement-pr', 'P', { maxTurns: 200, model: 'claude-opus-5-5', resume: 's-1' })).toEqual([
      'claude', '-p', 'P', '--output-format', 'stream-json', '--verbose', '--max-turns', '200', '--dangerously-skip-permissions',
      '--model', 'claude-opus-5-5', '--resume', 's-1',
    ]);
  });
});

describe('runAgent', () => {
  it('runs claude in the workspace, logs the stream and returns the parsed result', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ answer: 42, summary: 'Found it' });
    await expect(
      runAgent(deps, { job, item, kind: 'investigate', prompt: 'Investigate', schema, env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } }),
    ).resolves.toEqual({ answer: 42, summary: 'Found it' });
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec).toMatchObject({ container: 'wf-boo-1', workdir: '/work', env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' } });
    expect(exec.timeoutMs).toBe(20 * 60_000);
    const [run] = listRuns(db, item.id);
    expect(run).toMatchObject({ outcome: 'succeeded', summary: 'Found it', kind: 'investigate' });
    expect(readFileSync(run!.logPath, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('wraps the command with registry auth when a registry is given', async () => {
    const { deps, engine, item, job } = setup('implement-pr');
    engine.replyClaude({ answer: 1 });
    await runAgent(deps, {
      job, item, kind: 'implement-pr', prompt: 'Implement', schema,
      env: { CODEARTIFACT_AUTH_TOKEN: 'ca' }, registry: 'https://reg.example.com/npm/x/',
    });
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.args[0]).toBe('sh');
    expect(exec.args).toContain('--dangerously-skip-permissions');
    expect(exec.timeoutMs).toBe(60 * 60_000);
  });

  it('resumes once when the final message is not valid, then gives up', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude('I could not decide', { answer: 7 });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).resolves.toEqual({ answer: 7 });
    const second = engine.execs.filter(isClaudeExec)[1]!;
    expect(second.args).toContain('--resume');
    expect(second.args).toContain('s-1');

    engine.replyClaude('nope', 'still nope');
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toMatch(/invalid output twice/);
  });

  it('records timeouts and error results as permanent failures', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ timedOut: true, lines: [] });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toThrow(
      'Run timed out after 20 min',
    );
    expect(listRuns(db, item.id)[0]?.outcome).toBe('timed_out');

    engine.replyClaude({
      lines: [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's-9' })],
    });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toThrow(
      'Claude run ended with error_max_turns',
    );
  });

  it('kills the run when a stop is requested', async () => {
    const { deps, engine, item, job } = setup();
    engine.exec = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { exitCode: 143, stdout: '', stderr: '', timedOut: false, aborted: req.signal?.aborted ?? false };
    };
    requestStop(db, job.id);
    const err = await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('Run stopped by user');
    expect(listRuns(db, item.id)[0]?.outcome).toBe('stopped');
  });

  it('treats container exec failures as transient and marks the workspace broken', async () => {
    const { deps, engine, item, job } = setup();
    engine.replyClaude({ exitCode: 125, lines: [], stderr: 'no such container' });
    await expect(runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(getWorkspace(db, item.id)?.status).toBe('broken');
  });

  it('passes the configured model', async () => {
    const { deps, engine, item, job } = setup();
    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, claude: { model: 'claude-opus-5-5' } });
    engine.replyClaude({ answer: 1 });
    await runAgent(deps, { job, item, kind: 'investigate', prompt: 'P', schema, env: {} });
    expect(engine.execs.find(isClaudeExec)!.args).toContain('claude-opus-5-5');
    expect(existsSync(deps.runsDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker/agent/run.test.ts`
Expected: FAIL, because `./run` is missing.

- [ ] **Step 3: Implement `src/worker/agent/prompts.ts`**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderPrompt } from '@/core/clients/claude';

export type AgentPromptName = 'agent-investigate' | 'agent-implement' | 'agent-fix';

export function renderAgentPrompt(promptsDir: string, name: AgentPromptName, vars: Record<string, string>): string {
  return renderPrompt(readFileSync(path.join(promptsDir, `${name}.md`), 'utf8'), vars);
}
```

- [ ] **Step 4: Implement `src/worker/agent/run.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { extractJson } from '@/core/clients/claude';
import type { AgentRunKind, Item, Job } from '@/core/db/schema';
import { errorMessage, PermanentError, TransientError } from '@/core/errors';
import { isStopRequested } from '@/core/jobs/queue';
import { finishRun, startRun } from '@/core/work/runs';
import { parseStreamLine } from '@/core/work/stream';
import { updateWorkspace, workspaceName } from '@/core/work/workspaces';
import { withRegistryAuth } from './codeartifact';
import type { AgentDeps } from './deps';

export const INVESTIGATE_TOOLS =
  'Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git diff:*),Bash(ls:*)';
const STOP_POLL_MS = 1_000;
/** podman exec's own failures: container missing, not runnable, command not found. */
const ENGINE_EXIT_CODES = new Set([125, 126, 127]);

export function claudeArgs(
  kind: AgentRunKind,
  prompt: string,
  opts: { maxTurns: number; model: string | null; resume?: string },
): string[] {
  const args = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(opts.maxTurns)];
  if (kind === 'investigate') args.push('--allowedTools', INVESTIGATE_TOOLS);
  else args.push('--dangerously-skip-permissions');
  if (opts.model) args.push('--model', opts.model);
  if (opts.resume) args.push('--resume', opts.resume);
  return args;
}

export type AgentRunRequest<T> = {
  job: Job;
  item: Item;
  plannedPrId?: number | null;
  kind: AgentRunKind;
  prompt: string;
  schema: z.ZodType<T>;
  /** Passed into the container by name only. */
  env: Record<string, string>;
  /** When set, the command runs with npm/yarn auth for this registry (needs CODEARTIFACT_AUTH_TOKEN in env). */
  registry?: string | null;
};

type Final = { ok: boolean; subtype: string; text: string; sessionId: string | null };

class RunEnded extends Error {
  constructor(
    readonly outcome: 'stopped' | 'timed_out',
    message: string,
  ) {
    super(message);
  }
}

function parseResult<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.message };
}

function summarize(value: unknown): string {
  const summary = (value as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.slice(0, 500) : 'Completed';
}

/**
 * Runs one Claude Code session inside the item's container and returns its validated final JSON.
 * Invalid output is resumed once. Timeouts and stops are permanent failures; podman exec failures are transient.
 */
export async function runAgent<T>(deps: AgentDeps, req: AgentRunRequest<T>): Promise<T> {
  if (!req.item.linearIdentifier) throw new PermanentError(`Item #${req.item.id} has no Linear issue`);
  const cfg = deps.config.agent;
  const investigate = req.kind === 'investigate';
  const timeoutMs = (investigate ? cfg.timeoutMinutes.investigate : cfg.timeoutMinutes.implement) * 60_000;
  const maxTurns = investigate ? cfg.maxTurns.investigate : cfg.maxTurns.implement;
  const container = workspaceName(req.item.linearIdentifier);
  mkdirSync(deps.runsDir, { recursive: true });
  const logPath = path.join(deps.runsDir, `${req.job.id}-${deps.now()}.jsonl`);
  const run = startRun(
    deps.db,
    { jobId: req.job.id, itemId: req.item.id, plannedPrId: req.plannedPrId ?? null, kind: req.kind, logPath },
    deps.now(),
  );
  const controller = new AbortController();
  const stopTimer = setInterval(() => {
    if (isStopRequested(deps.db, req.job.id)) controller.abort();
  }, STOP_POLL_MS);

  const exec = async (prompt: string, resume?: string): Promise<Final> => {
    const base = claudeArgs(req.kind, prompt, { maxTurns, model: deps.config.claude.model, resume });
    const seen: { final: Final | null } = { final: null };
    const result = await deps.engine.exec({
      container,
      workdir: '/work',
      env: req.env,
      args: req.registry ? withRegistryAuth(base, req.registry) : base,
      timeoutMs,
      signal: controller.signal,
      onLine: (line) => {
        appendFileSync(logPath, `${line}\n`);
        for (const event of parseStreamLine(line)) if (event.type === 'result') seen.final = event;
      },
    });
    if (result.aborted) throw new RunEnded('stopped', 'Run stopped by user');
    if (result.timedOut) throw new RunEnded('timed_out', `Run timed out after ${timeoutMs / 60_000} min`);
    const final = seen.final;
    if (!final) {
      if (ENGINE_EXIT_CODES.has(result.exitCode)) {
        updateWorkspace(deps.db, req.item.id, { status: 'broken' }, deps.now());
        throw new TransientError(`Container exec failed (${result.exitCode}): ${result.stderr.trim().slice(-300)}`);
      }
      throw new PermanentError(`Claude exited with ${result.exitCode} without a result: ${result.stderr.trim().slice(-300)}`);
    }
    if (!final.ok) throw new PermanentError(`Claude run ended with ${final.subtype}${final.text ? `: ${final.text.slice(0, 300)}` : ''}`);
    return final;
  };

  try {
    const first = await exec(req.prompt);
    let parsed = parseResult(first.text, req.schema);
    if (!parsed.ok) {
      if (!first.sessionId) throw new PermanentError(`Claude returned invalid output: ${parsed.error}`);
      const second = await exec(
        `Your final message could not be used: ${parsed.error}\nReply again with only the JSON object described in the task.`,
        first.sessionId,
      );
      parsed = parseResult(second.text, req.schema);
      if (!parsed.ok) throw new PermanentError(`Claude returned invalid output twice: ${parsed.error}`);
    }
    finishRun(deps.db, run.id, 'succeeded', summarize(parsed.value), deps.now());
    return parsed.value;
  } catch (err) {
    if (err instanceof RunEnded) {
      finishRun(deps.db, run.id, err.outcome, err.message, deps.now());
      throw new PermanentError(err.message);
    }
    finishRun(deps.db, run.id, 'failed', errorMessage(err).slice(0, 500), deps.now());
    throw err;
  } finally {
    clearInterval(stopTimer);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/worker/agent && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/worker/agent/run.ts src/worker/agent/run.test.ts src/worker/agent/prompts.ts
git commit -m "feat: run Claude Code inside workspaces with logging, stop and timeouts" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 11: `investigate` handler and prompt

**Files:**
- Create: `prompts/agent-investigate.md`, `src/worker/agent/handlers/investigate.ts`
- Test: `src/worker/agent/handlers/investigate.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `renderAgentPrompt` (Task 10); `ensureWorkspace` (Task 9); `latestPlan`, `savePlan`, `renderPlanComment` (Task 2); `applyWorkEvent` (Task 2); `validateBreakdown` (Task 2); `formatThread` (`src/core/triage/format.ts`); `LinearClient.getIssueDetails` (Task 7); `HostTools.detectRepository` (Task 8).
- Produces: `investigateHandler: AgentHandler`, `planOutputSchema(map: RepoMap)`

- [ ] **Step 1: Write the prompt `prompts/agent-investigate.md`**

```markdown
You are investigating a Linear issue in MeetingPackage's code so a developer can approve an implementation plan.

<issue identifier="{{identifier}}">
<title>{{title}}</title>
<description>
{{description}}
</description>
</issue>

<slack_thread>
{{thread}}
</slack_thread>

The repositories are cloned under /work:
{{repos}}

Repository keys you may use in the breakdown: {{knownRepos}}

<previous_plan>
{{previousPlan}}
</previous_plan>

<reviewer_feedback>
{{feedback}}
</reviewer_feedback>

How to work:
- Read the code. Find where the problem happens and what has to change. Use only the read-only tools you have; do not try to edit files, install packages, or run builds.
- If the previous plan and feedback are given, revise the previous plan to address the feedback and keep everything the feedback does not mention.
- Do not restate the problem or acceptance criteria; the issue description already holds them.

Write the plan body in Markdown with these sections:
- **Findings**: what the code does today and why the problem happens, with file paths.
- **Approach**: the change, step by step, with the files and functions involved.
- **Risks**: what could break, migrations, flags, or things to verify.

Then split the work into the smallest sensible ordered PRs. Each PR changes exactly one repository (use only the keys listed above) and has a one-sentence scope. Put dependencies first (for example, an API change before the UI that uses it).

Reply with only a JSON object, no prose, in this shape:
{"body": "## Findings\n...\n## Approach\n...\n## Risks\n...", "breakdown": [{"repo": "<repository key>", "scope": "<one sentence>"}], "summary": "<one line: what the plan proposes>"}
```

- [ ] **Step 2: Write the failing test** `src/worker/agent/handlers/investigate.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { PermanentError } from '@/core/errors';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { latestPlan, savePlan } from '@/core/work/plans';
import { getWorkspace } from '@/core/work/workspaces';
import { configSchema } from '@/core/config/schema';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import { investigateHandler } from './investigate';

const output = {
  body: '## Findings\nParser disabled.\n## Approach\nScope it.\n## Risks\nNone.',
  breakdown: [{ repo: 'core', scope: 'Scope the raw-body parser to webhook routes' }],
  summary: 'One PR in core',
};
let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(payload: { feedback?: string } = {}, ids = { issueId: 'i1', identifier: 'BOO-1430' }) {
  const env = makeAgentDeps(db);
  const item = seedItem(db, { linearIssueId: ids.issueId, linearIdentifier: ids.identifier, workState: 'investigating', title: 'Bodies dropped' });
  env.linear.details.set(ids.issueId, {
    id: ids.issueId,
    identifier: ids.identifier,
    title: 'core-api drops every JSON request body',
    url: 'https://linear.app/x/BOO-1430',
    description: 'Every POST body arrives empty.',
    comments: [],
  });
  enqueueJob(db, 'investigate', item.id, payload, 0);
  return { ...env, item, job: claimNextJob(db, 0)! };
}

describe('investigateHandler', () => {
  it('investigates read-only and saves a plan', async () => {
    const { deps, engine, host, item, job } = setup();
    engine.replyClaude(output);
    await investigateHandler(deps, job);

    expect(latestPlan(db, item.id)).toMatchObject({ version: 1, author: 'claude', breakdown: output.breakdown });
    expect(getItem(db, item.id)?.workState).toBe('plan_ready');
    expect(getWorkspace(db, item.id)?.repos).toEqual(['core']);
    expect(host.detectCalls).toHaveLength(1);
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' });
    expect(exec.args).toContain('--allowedTools');
    expect(exec.args).not.toContain('--dangerously-skip-permissions');
    const prompt = exec.args[exec.args.indexOf('-p') + 1]!;
    expect(prompt).toContain('Every POST body arrives empty.');
    expect(prompt).toContain('- core (/work/core)');
    expect(prompt).toContain('Repository keys you may use in the breakdown: core, web, infra');
  });

  it('revises using the previous plan, its repos and the feedback', async () => {
    const { deps, engine, host, item, job } = (() => {
      const env = setup({ feedback: 'split the UI change out' });
      savePlan(db, env.item.id, { body: 'old body', breakdown: [{ repo: 'web', scope: 'old scope' }] }, 'claude', null, 0);
      return env;
    })();
    engine.replyClaude(output);
    await investigateHandler(deps, job);
    expect(host.detectCalls).toHaveLength(0);
    expect(getWorkspace(db, item.id)?.repos).toEqual(['web']);
    const prompt = engine.execs.find(isClaudeExec)!.args[2]!;
    expect(prompt).toContain('old scope');
    expect(prompt).toContain('split the UI change out');
    expect(latestPlan(db, item.id)).toMatchObject({ version: 2, feedback: 'split the UI change out' });
  });

  it('falls back to defaultRepos and fails clearly when no repository is known', async () => {
    const { deps, host, job } = setup();
    host.detected = null;
    await expect(investigateHandler(deps, job)).rejects.toThrow(/No repository detected/);

    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { defaultRepos: ['infra'] } });
    const second = setup({}, { issueId: 'i2', identifier: 'BOO-1431' });
    second.host.detected = null;
    second.deps.config = deps.config;
    second.engine.replyClaude({ ...output, breakdown: [{ repo: 'infra', scope: 'x' }] });
    await investigateHandler(second.deps, second.job);
    expect(getWorkspace(db, second.item.id)?.repos).toEqual(['infra']);
  });

  it('rejects breakdowns with unknown repos after one resume', async () => {
    const { deps, engine, job } = setup();
    const bad = { ...output, breakdown: [{ repo: 'mobile', scope: 'x' }] };
    engine.replyClaude(bad, bad);
    const err = await investigateHandler(deps, job).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('unknown repository "mobile"');
  });

  it('does nothing for a dismissed item, and saves nothing if dismissed during the run', async () => {
    const first = setup();
    updateItem(db, first.item.id, { category: 'dismissed' });
    await investigateHandler(first.deps, first.job);
    expect(first.engine.execs).toHaveLength(0);

    const second = setup({}, { issueId: 'i2', identifier: 'BOO-1431' });
    second.engine.replyClaude(output);
    const original = second.engine.exec.bind(second.engine);
    second.engine.exec = async (req) => {
      if (isClaudeExec(req)) updateItem(db, second.item.id, { category: 'dismissed' });
      return original(req);
    };
    await investigateHandler(second.deps, second.job);
    expect(latestPlan(db, second.item.id)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/worker/agent/handlers/investigate.test.ts`
Expected: FAIL, because `./investigate` is missing.

- [ ] **Step 4: Implement `src/worker/agent/handlers/investigate.ts`**

```ts
import { z } from 'zod';
import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { type RepoMap, validateBreakdown } from '@/core/repos/map';
import { formatThread } from '@/core/triage/format';
import { latestPlan, renderPlanComment, savePlan } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace } from '../workspace';

export function planOutputSchema(map: RepoMap) {
  return z
    .object({
      body: z.string().trim().min(1),
      breakdown: z.array(z.object({ repo: z.string().trim().min(1), scope: z.string().trim().min(1) })).min(1),
      summary: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const error = validateBreakdown(value.breakdown, map);
      if (error) ctx.addIssue({ code: 'custom', message: error });
    });
}

export const investigateHandler: AgentHandler = async (deps, job: Job) => {
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'investigating') return;
  if (!item.linearIssueId || !item.linearIdentifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const issue = await deps.linear.getIssueDetails(item.linearIssueId);
  if (!issue) throw new PermanentError(`Linear issue ${item.linearIdentifier} not found`);

  const map = deps.repoMap();
  const { feedback } = jobPayload(job as Job & { type: 'investigate' });
  const previous = feedback ? latestPlan(deps.db, item.id) : undefined;
  let repos = previous ? [...new Set(previous.breakdown.map((e) => e.repo))] : [];
  if (repos.length === 0) {
    const detected = await deps.host.detectRepository({
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      comments: issue.comments,
    });
    repos = detected ? [detected] : deps.config.agent.defaultRepos;
  }
  if (repos.length === 0) {
    throw new PermanentError('No repository detected for this issue. Set agent.defaultRepos in workflow.config.yaml or mention the repository in the issue.');
  }
  await ensureWorkspace(deps, item, repos);

  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-investigate', {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '(no description)',
    thread: item.slackThread?.length ? formatThread(item.slackThread) : '(none)',
    repos: repos.map((key) => `- ${key} (/work/${key})`).join('\n'),
    knownRepos: map.repos.map((r) => r.key).join(', '),
    previousPlan: previous ? renderPlanComment(previous) : '(none)',
    feedback: feedback ?? '(none)',
  });
  const output = await runAgent(deps, {
    job,
    item,
    kind: 'investigate',
    prompt,
    schema: planOutputSchema(map),
    env: { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken },
  });

  if (getItem(deps.db, item.id)?.category === 'dismissed') return;
  const now = deps.now();
  writeTransaction(deps.db, (tx) => {
    const plan = savePlan(tx, item.id, { body: output.body, breakdown: output.breakdown }, 'claude', feedback ?? null, now);
    applyWorkEvent(tx, item.id, { type: 'plan_saved' }, now);
    logActivity(tx, item.id, `Plan v${plan.version} by Claude (${output.breakdown.length} PR${output.breakdown.length === 1 ? '' : 's'})`, now);
  });
};
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add prompts/agent-investigate.md src/worker/agent/handlers/investigate.ts src/worker/agent/handlers/investigate.test.ts
git commit -m "feat: add read-only investigation runs that produce a plan" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 12: `post-plan` handler

**Files:**
- Create: `src/worker/handlers/post-plan.ts`
- Modify: `src/worker/handlers/types.ts`
- Test: `src/worker/handlers/post-plan.test.ts`

**Interfaces:**
- Consumes: `LinearClient.commentExists/createComment/setIssueStateByName` (Task 7); `createPlannedPrs`, `listPlannedPrs`, `renderPlanComment`, `latestPlan`, `applyWorkEvent`, `validateBreakdown` (Task 2); `enqueueJob` (Task 3).
- Produces: `HandlerContext.repoMap?: () => RepoMap` (optional, so existing tests stay unchanged), `postPlanHandler: Handler`

- [ ] **Step 1: Extend `src/worker/handlers/types.ts`**

```ts
import type { ClaudeClient, LinearClient, SlackClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';
import type { RepoMap } from '@/core/repos/map';

export type HandlerContext = {
  db: Db;
  config: Config;
  slack: SlackClient;
  linear: LinearClient;
  claude: ClaudeClient;
  now: () => number;
  /** Needed by post-plan to resolve breakdown repos. */
  repoMap?: () => RepoMap;
};

export type Handler = (ctx: HandlerContext, job: Job) => Promise<void>;
```

- [ ] **Step 2: Write the failing test** `src/worker/handlers/post-plan.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError, TransientError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { listPlannedPrs } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createTestDb } from '@/test/db';
import { FakeClaude, FakeLinear, FakeSlack, TEST_CONFIG } from '@/test/fakes';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { postPlanHandler } from './post-plan';
import type { HandlerContext } from './types';

const UUID = '6f1c1d2e-1111-4a5b-8c9d-0123456789ab';
let db: Db;
let linear: FakeLinear;
let ctx: HandlerContext;

beforeEach(() => {
  db = createTestDb();
  linear = new FakeLinear();
  ctx = { db, config: TEST_CONFIG, slack: new FakeSlack(), linear, claude: new FakeClaude(), now: () => 1_000, repoMap: () => TEST_REPO_MAP };
});

function approved(breakdown = [{ repo: 'core', scope: 'Add field' }, { repo: 'web', scope: 'Show field' }]) {
  const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-7', workState: 'posting_plan', category: 'triage' });
  savePlan(db, item.id, { body: 'Findings and approach', breakdown }, 'claude', null, 0);
  enqueueJob(db, 'post-plan', item.id, { commentUuid: UUID }, 0);
  return { item, job: claimNextJob(db, 0)! };
}

describe('postPlanHandler', () => {
  it('posts the plan comment and starts implementation of PR 1', async () => {
    const { item, job } = approved();
    await postPlanHandler(ctx, job);
    expect(linear.comments).toEqual([
      {
        id: UUID,
        issueId: 'i1',
        body: '## Implementation plan\n\nFindings and approach\n\n### PR breakdown\n1. `core` — Add field\n2. `web` — Show field\n',
      },
    ]);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'implementing', category: 'in_progress', planCommentId: UUID });
    const prs = listPlannedPrs(db, item.id);
    expect(prs.map((p) => p.branch)).toEqual(['boo-7-add-field', 'boo-7-show-field']);
    const queued = db.select().from(jobs).all().filter((j) => j.status === 'queued');
    expect(queued).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[0]!.id } }]);
  });

  it('never posts twice after a lost response', async () => {
    const { item, job } = approved();
    linear.loseNextCommentResponse = true;
    await expect(postPlanHandler(ctx, job)).rejects.toBeInstanceOf(TransientError);
    await postPlanHandler(ctx, job);
    expect(linear.comments).toHaveLength(1);
    expect(getItem(db, item.id)?.workState).toBe('implementing');
  });

  it('optionally moves the Linear issue, without blocking on failure', async () => {
    const { item, job } = approved();
    ctx.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { linearStatusOnImplement: 'In Progress' } });
    await postPlanHandler(ctx, job);
    expect(linear.stateChanges).toEqual([{ issueId: 'i1', stateName: 'In Progress' }]);

    const second = (() => {
      const it2 = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-8', workState: 'posting_plan' });
      savePlan(db, it2.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'claude', null, 0);
      enqueueJob(db, 'post-plan', it2.id, { commentUuid: '7f1c1d2e-1111-4a5b-8c9d-0123456789ab' }, 0);
      return { it2, job2: claimNextJob(db, 0, ['post-plan'])! };
    })();
    ctx.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { linearStatusOnImplement: 'Shipped' } });
    await postPlanHandler(ctx, second.job2);
    expect(getItem(db, second.it2.id)).toMatchObject({ workState: 'implementing', lastError: 'Linear state "Shipped" not found' });
    expect(listActivity(db, second.it2.id).at(-1)?.message).toContain('Could not move BOO-8');
    expect(item.id).not.toBe(second.it2.id);
  });

  it('fails permanently when the breakdown no longer matches the map', async () => {
    const { job } = approved([{ repo: 'gone', scope: 'x' }]);
    await expect(postPlanHandler(ctx, job)).rejects.toBeInstanceOf(PermanentError);
    expect(linear.comments).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/worker/handlers/post-plan.test.ts`
Expected: FAIL, because `./post-plan` is missing.

- [ ] **Step 4: Implement `src/worker/handlers/post-plan.ts`**

```ts
import type { Job } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { errorMessage, PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob, jobPayload } from '@/core/jobs/queue';
import { validateBreakdown } from '@/core/repos/map';
import { createPlannedPrs, listPlannedPrs } from '@/core/work/planned-prs';
import { latestPlan, renderPlanComment } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { Handler } from './types';

export const postPlanHandler: Handler = async (ctx, job: Job) => {
  const { db, linear } = ctx;
  const item = getItem(db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'posting_plan') return;
  if (!item.linearIssueId || !item.linearIdentifier) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const plan = latestPlan(db, item.id);
  if (!plan) throw new PermanentError(`Item #${item.id} has no plan`);
  if (!ctx.repoMap) throw new PermanentError('Repository map is not available to the worker');
  const map = ctx.repoMap();
  const invalid = validateBreakdown(plan.breakdown, map);
  if (invalid) throw new PermanentError(invalid);

  const { commentUuid } = jobPayload(job as Job & { type: 'post-plan' });
  if (!(await linear.commentExists(commentUuid))) {
    await linear.createComment({ id: commentUuid, issueId: item.linearIssueId, body: renderPlanComment(plan) });
  }
  if (getItem(db, item.id)?.category === 'dismissed') {
    updateItem(db, item.id, { planCommentId: commentUuid }, ctx.now());
    return;
  }

  const now = ctx.now();
  writeTransaction(db, (tx) => {
    updateItem(tx, item.id, { planCommentId: commentUuid, category: 'in_progress' }, now);
    const prs = listPlannedPrs(tx, item.id).length > 0 ? listPlannedPrs(tx, item.id) : createPlannedPrs(tx, item, plan, map, now);
    applyWorkEvent(tx, item.id, { type: 'plan_posted' }, now);
    enqueueJob(tx, 'implement-pr', item.id, { plannedPrId: prs[0]!.id }, now);
    logActivity(tx, item.id, `Plan v${plan.version} posted to ${item.linearIdentifier}; implementing ${prs.length} PR${prs.length === 1 ? '' : 's'}`, now);
  });

  const status = ctx.config.agent.linearStatusOnImplement;
  if (status) {
    try {
      await linear.setIssueStateByName(item.linearIssueId, status);
    } catch (err) {
      updateItem(db, item.id, { lastError: errorMessage(err) }, ctx.now());
      logActivity(db, item.id, `Could not move ${item.linearIdentifier} to "${status}": ${errorMessage(err)}`, ctx.now());
    }
  }
};
```

- [ ] **Step 5: Register it in the core lane**

In `src/worker/runner.ts`, add `import { postPlanHandler } from './handlers/post-plan';` and add `'post-plan': postPlanHandler,` to `HANDLERS`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/worker/handlers/types.ts src/worker/handlers/post-plan.ts src/worker/handlers/post-plan.test.ts src/worker/runner.ts
git commit -m "feat: post approved plans to Linear exactly once and start implementation" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 13: `implement-pr` handler and prompt

**Files:**
- Create: `prompts/agent-implement.md`, `src/worker/agent/handlers/implement-pr.ts`
- Test: `src/worker/agent/handlers/implement-pr.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 9 and 10.
- Produces: `implementPrHandler: AgentHandler`, `afterPrOpened(deps: AgentDeps, itemId: number): void`

- [ ] **Step 1: Write the prompt `prompts/agent-implement.md`**

```markdown
You are implementing one pull request for Linear issue {{identifier}} in MeetingPackage's code. You work alone and unattended inside a sandbox container.

<issue identifier="{{identifier}}" url="{{linearUrl}}">
<title>{{title}}</title>
<description>
{{description}}
</description>
</issue>

<approved_plan>
{{planBody}}
</approved_plan>

This is PR {{position}} of {{total}}.
- Repository: {{githubRepo}} (key `{{repo}}`), cloned at {{repoPath}}
- Default branch: {{defaultBranch}}
- Branch to create: {{branch}}
- Scope of this PR: {{scope}}

PRs already opened for this issue:
{{priorPrs}}

Validation commands for this repository (run them from {{repoPath}}):
{{validation}}

Steps:
1. `cd {{repoPath}}`, `git fetch origin`, then `git checkout -B {{branch}} origin/{{defaultBranch}}`. If `origin/{{branch}}` already exists, check it out instead and continue from it.
2. Implement only the scope of this PR, following the approved plan and the repository's existing patterns. Keep the change minimal and focused. Add or update tests where the repository has them.
3. Run every validation command and fix what fails. If a failure is unrelated to your change and also fails on {{defaultBranch}}, note it in the PR body instead of fixing it.
4. Commit with clear conventional messages. Do not add Co-authored-by trailers, "generated by" lines, or any AI branding to commits, the PR title, or the PR body.
5. `git push -u origin {{branch}}`.
6. Open a **draft** PR with `gh pr create --draft --base {{defaultBranch}} --head {{branch}}`. Title: a short description of the change. Body: what changed and why, how it was validated, `Linear: {{linearUrl}}`, and the list of earlier PRs above if any. Do not assign reviewers or assignees.

Reply with only a JSON object, no prose, in this shape:
{"prNumber": 123, "prUrl": "https://github.com/{{githubRepo}}/pull/123", "branch": "{{branch}}", "summary": "<one line: what this PR does>"}
```

- [ ] **Step 2: Write the failing test** `src/worker/agent/handlers/implement-pr.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { jobs } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { getItem, updateItem } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createPlannedPrs, getPlannedPr, listPlannedPrs } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { implementPrHandler } from './implement-pr';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(breakdown = [{ repo: 'core', scope: 'Add field' }, { repo: 'web', scope: 'Show field' }]) {
  const env = makeAgentDeps(db);
  const item = seedItem(db, {
    linearIssueId: 'i1',
    linearIdentifier: 'BOO-7',
    linearUrl: 'https://linear.app/x/BOO-7',
    workState: 'implementing',
    category: 'in_progress',
  });
  env.linear.details.set('i1', { id: 'i1', identifier: 'BOO-7', title: 'Add field', url: 'https://linear.app/x/BOO-7', description: 'Need a field', comments: [] });
  const plan = savePlan(db, item.id, { body: 'Approach: add it', breakdown }, 'claude', null, 0);
  const prs = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
  enqueueJob(db, 'implement-pr', item.id, { plannedPrId: prs[0]!.id }, 0);
  return { ...env, item, prs, job: claimNextJob(db, 0)! };
}
const queued = () => db.select().from(jobs).all().filter((j) => j.status === 'queued');

describe('implementPrHandler', () => {
  it('implements PR 1, verifies it on GitHub and queues PR 2', async () => {
    const { deps, engine, github, item, prs, job } = setup();
    github.addOpenPr('acme/core', 12, 'boo-7-add-field');
    engine.replyClaude({ prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', branch: 'boo-7-add-field', summary: 'Adds the field' });
    await implementPrHandler(deps, job);

    expect(getPlannedPr(db, prs[0]!.id)).toMatchObject({ state: 'open', prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', isDraft: true });
    expect(queued()).toMatchObject([{ type: 'implement-pr', payload: { plannedPrId: prs[1]!.id } }]);
    expect(getItem(db, item.id)?.workState).toBe('implementing');
    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-token', GH_TOKEN: 'gh-token', CODEARTIFACT_AUTH_TOKEN: 'ca-token' });
    expect(exec.args[0]).toBe('sh');
    const prompt = exec.args[exec.args.indexOf('-p') + 1]!;
    expect(prompt).toContain('PR 1 of 2');
    expect(prompt).toContain('Branch to create: boo-7-add-field');
    expect(prompt).toContain('yarn lint:quiet');
  });

  it('moves the item to verification after the last PR', async () => {
    const { deps, engine, github, item, job } = setup([{ repo: 'web', scope: 'Show field' }]);
    github.addOpenPr('acme/web', 3, 'boo-7-show-field');
    engine.replyClaude({ prNumber: 3, prUrl: 'https://github.com/acme/web/pull/3', branch: 'boo-7-show-field', summary: 'UI' });
    await implementPrHandler(deps, job);
    expect(getItem(db, item.id)).toMatchObject({ workState: 'prs_open', category: 'verification' });
    expect(queued()).toHaveLength(0);
  });

  it('reuses an already-open PR for the branch after a restart instead of running Claude again', async () => {
    const { deps, engine, github, prs, job } = setup();
    github.addOpenPr('acme/core', 12, 'boo-7-add-field');
    await implementPrHandler(deps, job);
    expect(engine.execs.some(isClaudeExec)).toBe(false);
    expect(getPlannedPr(db, prs[0]!.id)).toMatchObject({ state: 'open', prNumber: 12 });
  });

  it('fails permanently when the reported PR does not exist on GitHub', async () => {
    const { deps, engine, job } = setup();
    engine.replyClaude({ prNumber: 99, prUrl: 'https://github.com/acme/core/pull/99', branch: 'boo-7-add-field', summary: 'x' });
    const err = await implementPrHandler(deps, job).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toContain('GitHub shows no open PR #99');
  });

  it('records the PR but starts no further work when dismissed during the run', async () => {
    const { deps, engine, github, item, prs, job } = setup();
    github.addOpenPr('acme/core', 12, 'boo-7-add-field');
    engine.replyClaude({ prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12', branch: 'boo-7-add-field', summary: 'x' });
    const original = engine.exec.bind(engine);
    engine.exec = async (req) => {
      if (isClaudeExec(req)) updateItem(db, item.id, { category: 'dismissed' });
      return original(req);
    };
    await implementPrHandler(deps, job);
    expect(getPlannedPr(db, prs[0]!.id)?.state).toBe('open');
    expect(queued()).toHaveLength(0);
    expect(listPlannedPrs(db, item.id)[1]?.state).toBe('pending');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/worker/agent/handlers/implement-pr.test.ts`
Expected: FAIL, because `./implement-pr` is missing.

- [ ] **Step 4: Implement `src/worker/agent/handlers/implement-pr.ts`**

```ts
import { z } from 'zod';
import type { PullRequestInfo } from '@/core/clients/types';
import type { Job, PlannedPr } from '@/core/db/schema';
import { writeTransaction } from '@/core/db/tx';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { enqueueJob, jobPayload } from '@/core/jobs/queue';
import { findRepo } from '@/core/repos/map';
import { allPrsOpen, getPlannedPr, listPlannedPrs, nextPendingPr, updatePlannedPr } from '@/core/work/planned-prs';
import { latestPlan } from '@/core/work/plans';
import { applyWorkEvent } from '@/core/work/state';
import type { AgentDeps, AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace, registryAuth } from '../workspace';

const outputSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
  branch: z.string().min(1),
  summary: z.string(),
});

function markOpen(deps: AgentDeps, pr: PlannedPr, info: PullRequestInfo): void {
  updatePlannedPr(
    deps.db,
    pr.id,
    { state: 'open', prNumber: info.number, prUrl: info.url, isDraft: info.isDraft, branch: info.headRefName, lastError: null },
    deps.now(),
  );
  logActivity(deps.db, pr.itemId, `Opened ${pr.githubRepo}#${info.number} (PR ${pr.position})`, deps.now());
}

/** Queues the next planned PR, or finishes implementation when every planned PR is open. */
export function afterPrOpened(deps: AgentDeps, itemId: number): void {
  const item = getItem(deps.db, itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'implementing') return;
  writeTransaction(deps.db, (tx) => {
    const next = nextPendingPr(tx, itemId);
    if (next) {
      enqueueJob(tx, 'implement-pr', itemId, { plannedPrId: next.id }, deps.now());
      return;
    }
    if (!allPrsOpen(tx, itemId)) return;
    applyWorkEvent(tx, itemId, { type: 'all_prs_open' }, deps.now());
    updateItem(tx, itemId, { category: 'verification' }, deps.now());
    logActivity(tx, itemId, 'All planned PRs are open; moved to Verification', deps.now());
  });
}

export const implementPrHandler: AgentHandler = async (deps, job: Job) => {
  const { plannedPrId } = jobPayload(job as Job & { type: 'implement-pr' });
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed' || item.workState !== 'implementing') return;
  const pr = getPlannedPr(deps.db, plannedPrId);
  if (!pr || pr.itemId !== item.id) throw new PermanentError(`Planned PR #${plannedPrId} does not belong to item #${item.id}`);
  if (pr.state === 'open') return afterPrOpened(deps, item.id);

  // After a crash or restart the PR may already exist. Never open a second one.
  const existing = await deps.github.findOpenPrForBranch(pr.githubRepo, pr.branch);
  if (existing) {
    markOpen(deps, pr, existing);
    return afterPrOpened(deps, item.id);
  }

  updatePlannedPr(deps.db, pr.id, { state: 'implementing', lastError: null }, deps.now());
  const repo = findRepo(deps.repoMap(), pr.repoKey);
  if (!repo) throw new PermanentError(`Unknown repository "${pr.repoKey}"`);
  if (!item.linearIssueId) throw new PermanentError(`Item #${item.id} has no Linear issue`);
  const issue = await deps.linear.getIssueDetails(item.linearIssueId);
  if (!issue) throw new PermanentError(`Linear issue ${item.linearIdentifier} not found`);
  await ensureWorkspace(deps, item, [pr.repoKey]);

  const all = listPlannedPrs(deps.db, item.id);
  const prior = all.filter((p) => p.state === 'open' && p.prUrl);
  const auth = await registryAuth(deps, repo);
  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-implement', {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '(no description)',
    linearUrl: issue.url,
    planBody: latestPlan(deps.db, item.id)?.body ?? '(missing)',
    position: String(pr.position),
    total: String(all.length),
    repo: repo.key,
    githubRepo: repo.repo,
    repoPath: `/work/${repo.key}`,
    defaultBranch: repo.defaultBranch,
    branch: pr.branch,
    scope: pr.scope,
    priorPrs: prior.length ? prior.map((p) => `- PR ${p.position}: ${p.prUrl}`).join('\n') : '(none)',
    validation: repo.validationCommands.length ? repo.validationCommands.map((c) => `- ${c}`).join('\n') : '(none configured)',
  });
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken, GH_TOKEN: deps.secrets.ghToken };
  if (auth) env.CODEARTIFACT_AUTH_TOKEN = auth.token;
  const output = await runAgent(deps, {
    job,
    item,
    plannedPrId: pr.id,
    kind: 'implement-pr',
    prompt,
    schema: outputSchema,
    env,
    registry: auth?.registry ?? null,
  });

  const info = await deps.github.getPullRequest(pr.githubRepo, output.prNumber);
  if (!info || info.state !== 'OPEN' || info.headRefName !== pr.branch) {
    throw new PermanentError(
      `Claude reported PR #${output.prNumber} but GitHub shows no open PR #${output.prNumber} for branch ${pr.branch} in ${pr.githubRepo}`,
    );
  }
  markOpen(deps, pr, info);
  afterPrOpened(deps, item.id);
};
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add prompts/agent-implement.md src/worker/agent/handlers/implement-pr.ts src/worker/agent/handlers/implement-pr.test.ts
git commit -m "feat: implement planned PRs one by one as verified draft PRs" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 14: `fix-pr` handler and prompt

**Files:**
- Create: `prompts/agent-fix.md`, `src/worker/agent/handlers/fix-pr.ts`
- Test: `src/worker/agent/handlers/fix-pr.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 9 and 10.
- Produces: `fixPrHandler: AgentHandler`, `formatThreads(threads: ReviewThread[]): string`, `formatChecks(checks: FailingCheck[]): string`

- [ ] **Step 1: Write the prompt `prompts/agent-fix.md`**

```markdown
You are doing one fix round on a draft pull request for Linear issue {{identifier}}. You work alone and unattended inside a sandbox container.

- Repository: {{githubRepo}}, cloned at {{repoPath}}
- Pull request: #{{prNumber}} ({{prUrl}}), branch {{branch}}

Unresolved review threads:
{{threads}}

Failing checks:
{{checks}}

Validation commands (run from {{repoPath}}):
{{validation}}

Steps:
1. `cd {{repoPath}}`, `git fetch origin`, `git checkout {{branch}}`, `git pull --ff-only origin {{branch}}`.
2. Address each review thread and each failing check. Keep changes minimal and within the PR's purpose. If you disagree with a review comment, or it cannot be fixed within this PR, leave it unchanged.
3. Run the validation commands and fix what fails.
4. Commit with clear conventional messages (no Co-authored-by trailers, no AI branding) and `git push`.
5. For each thread you addressed, reply on it with one line describing the change, then resolve it:
   `gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}' -f id=<threadId> -f body='<reply>'`
   `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<threadId>`
   For each thread you left unchanged, reply explaining why and do not resolve it.

Reply with only a JSON object, no prose, in this shape:
{"addressed": ["<threadId>"], "notAddressed": [{"threadId": "<threadId>", "reason": "<why>"}], "summary": "<one line: what changed>"}
```

- [ ] **Step 2: Write the failing test** `src/worker/agent/handlers/fix-pr.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/core/db/client';
import { PermanentError } from '@/core/errors';
import { getItem, listActivity } from '@/core/items';
import { claimNextJob, enqueueJob } from '@/core/jobs/queue';
import { createPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { makeAgentDeps } from '@/test/agent';
import { isClaudeExec } from '@/test/fake-engine';
import { createTestDb } from '@/test/db';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { fixPrHandler, formatChecks, formatThreads } from './fix-pr';

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

function setup(open = true) {
  const env = makeAgentDeps(db);
  const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-7', workState: 'prs_open', category: 'verification' });
  const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'Add field' }] }, 'claude', null, 0);
  const [pr] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
  if (open) updatePlannedPr(db, pr!.id, { state: 'open', prNumber: 12, prUrl: 'https://github.com/acme/core/pull/12' }, 0);
  enqueueJob(db, 'fix-pr', item.id, { plannedPrId: pr!.id }, 0);
  return { ...env, item, pr: pr!, job: claimNextJob(db, 0)! };
}

describe('formatting', () => {
  it('formats threads and checks for the prompt', () => {
    expect(formatThreads([{ id: 'T1', path: 'src/a.ts', line: 4, comments: [{ author: 'coderabbitai', body: 'Handle null' }] }])).toBe(
      '### Thread T1 — src/a.ts:4\n- @coderabbitai: Handle null',
    );
    expect(formatThreads([])).toBe('(none)');
    expect(formatChecks([{ name: 'lint', summary: 'Lint failed', logTail: 'error x' }])).toBe(
      '### lint — Lint failed\n```\nerror x\n```',
    );
  });
});

describe('fixPrHandler', () => {
  it('runs one fix round with the threads and failing checks', async () => {
    const { deps, engine, github, item, job } = setup();
    github.threads.set('acme/core#12', [{ id: 'T1', path: 'src/a.ts', line: 4, comments: [{ author: 'coderabbitai', body: 'Handle null' }] }]);
    github.checks.set('acme/core#12', [{ name: 'lint', summary: 'Lint failed', logTail: 'error: unused var' }]);
    engine.replyClaude({ addressed: ['T1'], notAddressed: [], summary: 'Handled null and fixed lint' });
    await fixPrHandler(deps, job);

    const exec = engine.execs.find(isClaudeExec)!;
    expect(exec.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-token', GH_TOKEN: 'gh-token' });
    const prompt = exec.args[exec.args.indexOf('-p') + 1]!;
    expect(prompt).toContain('Handle null');
    expect(prompt).toContain('error: unused var');
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Fix round on acme/core#12: addressed 1, left 0 — Handled null and fixed lint');
    expect(getItem(db, item.id)?.workState).toBe('prs_open');
  });

  it('skips the run when there is nothing to fix', async () => {
    const { deps, engine, item, job } = setup();
    await fixPrHandler(deps, job);
    expect(engine.execs.some(isClaudeExec)).toBe(false);
    expect(listActivity(db, item.id).at(-1)?.message).toBe('Nothing to fix on acme/core#12: no unresolved threads or failing checks');
  });

  it('fails permanently for a PR that is not open', async () => {
    const { deps, job } = setup(false);
    await expect(fixPrHandler(deps, job)).rejects.toBeInstanceOf(PermanentError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/worker/agent/handlers/fix-pr.test.ts`
Expected: FAIL, because `./fix-pr` is missing.

- [ ] **Step 4: Implement `src/worker/agent/handlers/fix-pr.ts`**

```ts
import { z } from 'zod';
import type { FailingCheck, ReviewThread } from '@/core/clients/types';
import type { Job } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { getItem, logActivity, updateItem } from '@/core/items';
import { jobPayload } from '@/core/jobs/queue';
import { findRepo } from '@/core/repos/map';
import { getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import type { AgentHandler } from '../deps';
import { renderAgentPrompt } from '../prompts';
import { runAgent } from '../run';
import { ensureWorkspace, registryAuth } from '../workspace';

const outputSchema = z.object({
  addressed: z.array(z.string()),
  notAddressed: z.array(z.object({ threadId: z.string(), reason: z.string() })),
  summary: z.string(),
});

export function formatThreads(threads: ReviewThread[]): string {
  if (threads.length === 0) return '(none)';
  return threads
    .map((t) => {
      const where = t.path ? ` — ${t.path}${t.line ? `:${t.line}` : ''}` : '';
      return [`### Thread ${t.id}${where}`, ...t.comments.map((c) => `- @${c.author}: ${c.body}`)].join('\n');
    })
    .join('\n\n');
}

export function formatChecks(checks: FailingCheck[]): string {
  if (checks.length === 0) return '(none)';
  return checks
    .map((c) => [`### ${c.name}${c.summary ? ` — ${c.summary}` : ''}`, ...(c.logTail ? ['```', c.logTail, '```'] : [])].join('\n'))
    .join('\n\n');
}

export const fixPrHandler: AgentHandler = async (deps, job: Job) => {
  const { plannedPrId } = jobPayload(job as Job & { type: 'fix-pr' });
  const item = getItem(deps.db, job.itemId);
  if (!item || item.category === 'dismissed') return;
  if (item.workState !== 'implementing' && item.workState !== 'prs_open') return;
  const pr = getPlannedPr(deps.db, plannedPrId);
  if (!pr || pr.itemId !== item.id || pr.state !== 'open' || !pr.prNumber) {
    throw new PermanentError(`Planned PR #${plannedPrId} is not an open PR of item #${item.id}`);
  }
  const label = `${pr.githubRepo}#${pr.prNumber}`;
  const [threads, checks] = await Promise.all([
    deps.github.unresolvedThreads(pr.githubRepo, pr.prNumber),
    deps.github.failingChecks(pr.githubRepo, pr.prNumber),
  ]);
  if (threads.length === 0 && checks.length === 0) {
    logActivity(deps.db, item.id, `Nothing to fix on ${label}: no unresolved threads or failing checks`, deps.now());
    return;
  }
  const repo = findRepo(deps.repoMap(), pr.repoKey);
  if (!repo) throw new PermanentError(`Unknown repository "${pr.repoKey}"`);
  await ensureWorkspace(deps, item, [pr.repoKey]);
  const auth = await registryAuth(deps, repo);
  const prompt = renderAgentPrompt(deps.promptsDir, 'agent-fix', {
    identifier: item.linearIdentifier ?? `#${item.id}`,
    githubRepo: pr.githubRepo,
    repoPath: `/work/${pr.repoKey}`,
    prNumber: String(pr.prNumber),
    prUrl: pr.prUrl ?? '',
    branch: pr.branch,
    threads: formatThreads(threads),
    checks: formatChecks(checks),
    validation: repo.validationCommands.length ? repo.validationCommands.map((c) => `- ${c}`).join('\n') : '(none configured)',
  });
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: deps.secrets.claudeToken, GH_TOKEN: deps.secrets.ghToken };
  if (auth) env.CODEARTIFACT_AUTH_TOKEN = auth.token;
  const output = await runAgent(deps, {
    job,
    item,
    plannedPrId: pr.id,
    kind: 'fix-pr',
    prompt,
    schema: outputSchema,
    env,
    registry: auth?.registry ?? null,
  });
  updatePlannedPr(deps.db, pr.id, { lastError: null }, deps.now());
  updateItem(deps.db, item.id, { lastError: null }, deps.now());
  logActivity(
    deps.db,
    item.id,
    `Fix round on ${label}: addressed ${output.addressed.length}, left ${output.notAddressed.length} — ${output.summary}`,
    deps.now(),
  );
};
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/worker && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add prompts/agent-fix.md src/worker/agent/handlers/fix-pr.ts src/worker/agent/handlers/fix-pr.test.ts
git commit -m "feat: add on-demand fix rounds for open PRs" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 15: GitHub poller, agent lane and worker wiring

**Files:**
- Create: `src/worker/pollers/github.ts`, `src/worker/agent/lane.ts`
- Modify: `src/worker/runner.ts`, `src/worker/main.ts`, `scripts/smoke.ts`, `.env.op.example`
- Test: `src/worker/pollers/github.test.ts`, `src/worker/agent/lane.test.ts`, `src/worker/runner.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1–14.
- Produces:
  - `pollGithub(deps: { db: Db; github: GitHubClient }, now?: number): Promise<{ updated: number }>`
  - `AGENT_HANDLERS: Record<AgentJobType, AgentHandler>`
  - `class AgentLane { constructor(deps: () => AgentDeps | null, handlers?: Record<AgentJobType, AgentHandler>); fill(): number; drain(): Promise<void>; get size(): number }`
  - `pollOnce` deps gain `github?: GitHubClient | null`
  - `AGENT_NOT_CONFIGURED: string`

- [ ] **Step 1: Write the failing tests**

`src/worker/pollers/github.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getCursor } from '@/core/cursors';
import { createPlannedPrs, getPlannedPr, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { createTestDb } from '@/test/db';
import { FakeGitHub } from '@/test/fakes';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { seedItem } from '@/test/seed';
import { pollGithub } from './github';

describe('pollGithub', () => {
  it('refreshes open PRs of active items only', async () => {
    const db = createTestDb();
    const github = new FakeGitHub();
    const active = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const done = seedItem(db, { linearIssueId: 'i2', linearIdentifier: 'BOO-2', workState: null });
    const planA = savePlan(db, active.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }, { repo: 'web', scope: 'y' }] }, 'user', null, 0);
    const [a1, a2] = createPlannedPrs(db, active, planA, TEST_REPO_MAP, 0);
    updatePlannedPr(db, a1!.id, { state: 'open', prNumber: 12 }, 0);
    const planB = savePlan(db, done.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'z' }] }, 'user', null, 0);
    const [b1] = createPlannedPrs(db, done, planB, TEST_REPO_MAP, 0);
    updatePlannedPr(db, b1!.id, { state: 'open', prNumber: 40 }, 0);
    github.statuses.set('acme/core#12', { isDraft: false, merged: false, state: 'OPEN', unresolvedThreads: 2, ciState: 'failure' });

    await expect(pollGithub({ db, github }, 500)).resolves.toEqual({ updated: 1 });
    expect(github.statusCalls).toEqual([[{ repo: 'acme/core', number: 12 }]]);
    expect(getPlannedPr(db, a1!.id)).toMatchObject({ isDraft: false, unresolvedThreads: 2, ciState: 'failure', polledAt: 500 });
    expect(getPlannedPr(db, a2!.id)?.polledAt).toBeNull();
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(500);
  });
});
```

`src/worker/agent/lane.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configSchema } from '@/core/config/schema';
import { jobs } from '@/core/db/schema';
import { enqueueJob } from '@/core/jobs/queue';
import { makeAgentDeps } from '@/test/agent';
import { createTestDb } from '@/test/db';
import { seedItem } from '@/test/seed';
import type { AgentHandler } from './deps';
import { AgentLane } from './lane';

describe('AgentLane', () => {
  it('runs at most maxConcurrent agent jobs and records completion', async () => {
    const db = createTestDb();
    const { deps } = makeAgentDeps(db);
    const a = seedItem(db);
    const b = seedItem(db);
    const first = enqueueJob(db, 'investigate', a.id, {}, 0);
    const second = enqueueJob(db, 'investigate', b.id, {}, 0);
    enqueueJob(db, 'draft', a.id, {}, 0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler: AgentHandler = async () => {
      await gate;
    };
    const handlers = { investigate: handler, 'implement-pr': handler, 'fix-pr': handler, 'remove-workspace': handler };
    const lane = new AgentLane(() => deps, handlers);

    expect(lane.fill()).toBe(1);
    expect(lane.fill()).toBe(0);
    expect(db.select().from(jobs).where(eq(jobs.id, second.id)).get()?.status).toBe('queued');
    release();
    await lane.drain();
    expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.status).toBe('done');

    deps.config = configSchema.parse({ linear: { defaultTeam: 'ENG' }, agent: { maxConcurrent: 2 } });
    expect(lane.fill()).toBe(1);
    await lane.drain();
    expect(db.select().from(jobs).all().filter((j) => j.type === 'draft')[0]?.status).toBe('queued');
  });

  it('does nothing while agent workers are not configured', () => {
    const lane = new AgentLane(() => null);
    expect(lane.fill()).toBe(0);
  });
});
```

Add to `src/worker/runner.test.ts`:
```ts
describe('pollOnce with GitHub', () => {
  it('records that agent workers are not configured when there is no GitHub client', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: null }) };
    await pollOnce({ db, slack, linear: new FakeLinear(), configStore, github: null }, 10);
    expect(getCursor(db, 'github')?.lastError).toMatch(/agent workers not configured/);
  });

  it('polls GitHub only when prPollSeconds have passed', async () => {
    const slack = new FakeSlack();
    slack.setPages([]);
    const github = new FakeGitHub();
    const configStore = { reload: () => ({ config: TEST_CONFIG, error: null }) };
    await pollOnce({ db, slack, linear: new FakeLinear(), configStore, github }, 1_000_000);
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(1_000_000);
    await pollOnce({ db, slack, linear: new FakeLinear(), configStore, github }, 1_000_000 + 60_000);
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(1_000_000);
    await pollOnce({ db, slack, linear: new FakeLinear(), configStore, github }, 1_000_000 + 120_000);
    expect(getCursor(db, 'github')?.lastSuccessAt).toBe(1_120_000);
  });
});
```
(add `FakeGitHub` to the existing `@/test/fakes` import in that file).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/worker`
Expected: FAIL, because the new modules are missing and `pollOnce` ignores `github`.

- [ ] **Step 3: Implement `src/worker/pollers/github.ts`**

```ts
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { prKey } from '@/core/clients/github';
import type { GitHubClient } from '@/core/clients/types';
import { recordPollSuccess } from '@/core/cursors';
import type { Db } from '@/core/db/client';
import { items, plannedPrs } from '@/core/db/schema';
import { updatePlannedPr } from '@/core/work/planned-prs';

/** Refreshes draft/merged, unresolved threads and CI state for open PRs of items still in implementation. */
export async function pollGithub(deps: { db: Db; github: GitHubClient }, now = Date.now()): Promise<{ updated: number }> {
  const rows = deps.db
    .select({ id: plannedPrs.id, repo: plannedPrs.githubRepo, number: plannedPrs.prNumber })
    .from(plannedPrs)
    .innerJoin(items, eq(items.id, plannedPrs.itemId))
    .where(and(eq(plannedPrs.state, 'open'), isNotNull(plannedPrs.prNumber), inArray(items.workState, ['implementing', 'prs_open'])))
    .all();
  let updated = 0;
  if (rows.length > 0) {
    const statuses = await deps.github.prStatuses(rows.map((r) => ({ repo: r.repo, number: r.number! })));
    for (const row of rows) {
      const status = statuses.get(prKey(row.repo, row.number!));
      if (!status) continue;
      updatePlannedPr(
        deps.db,
        row.id,
        { isDraft: status.isDraft, merged: status.merged, unresolvedThreads: status.unresolvedThreads, ciState: status.ciState, polledAt: now },
        now,
      );
      updated++;
    }
  }
  recordPollSuccess(deps.db, 'github', null, now);
  return { updated };
}
```

- [ ] **Step 4: Implement `src/worker/agent/lane.ts`**

```ts
import type { AgentJobType } from '@/core/db/schema';
import { AGENT_JOB_TYPES } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { claimNextJob } from '@/core/jobs/queue';
import { executeJob } from '../execute';
import type { AgentDeps, AgentHandler } from './deps';
import { fixPrHandler } from './handlers/fix-pr';
import { implementPrHandler } from './handlers/implement-pr';
import { investigateHandler } from './handlers/investigate';
import { removeWorkspaceHandler } from './workspace';

export const AGENT_HANDLERS: Record<AgentJobType, AgentHandler> = {
  investigate: investigateHandler,
  'implement-pr': implementPrHandler,
  'fix-pr': fixPrHandler,
  'remove-workspace': removeWorkspaceHandler,
};

/** Runs long agent jobs concurrently with the core lane, up to `agent.maxConcurrent` at a time. */
export class AgentLane {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly deps: () => AgentDeps | null,
    private readonly handlers: Record<AgentJobType, AgentHandler> = AGENT_HANDLERS,
  ) {}

  get size(): number {
    return this.inFlight.size;
  }

  /** Claims and starts agent jobs until the lane is full. Returns how many were started. */
  fill(): number {
    const deps = this.deps();
    if (!deps) return 0;
    let started = 0;
    while (this.inFlight.size < deps.config.agent.maxConcurrent) {
      const job = claimNextJob(deps.db, deps.now(), AGENT_JOB_TYPES);
      if (!job) break;
      const handler = this.handlers[job.type as AgentJobType];
      const task: Promise<void> = executeJob(
        deps.db,
        job,
        () => (handler ? handler(deps, job) : Promise.reject(new PermanentError(`No agent handler for ${job.type}`))),
        deps.now,
      ).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
      started++;
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
```

- [ ] **Step 5: Extend `pollOnce` in `src/worker/runner.ts`**

Add these imports:
```ts
import type { GitHubClient } from '@/core/clients/types';
import { getCursor } from '@/core/cursors';
import { enqueueWorkspaceGc } from '@/core/work/gc';
import { pollGithub } from './pollers/github';
```
Add an exported constant:
```ts
export const AGENT_NOT_CONFIGURED =
  'agent workers not configured — add GITHUB_TOKEN, GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN references to .env.op';
```
Change the `pollOnce` deps type to `{ db: Db; slack: SlackClient; linear: LinearClient; configStore: Pick<ConfigStore, 'reload'>; github?: GitHubClient | null }`, and, after the existing `for (const [source, poll] of pollers)` loop and before `return config;`, add:
```ts
  if (deps.github) {
    const last = getCursor(db, 'github')?.lastSuccessAt ?? 0;
    if (now - last >= config.agent.prPollSeconds * 1000) {
      try {
        await pollGithub({ db, github: deps.github }, now);
      } catch (err) {
        recordPollError(db, 'github', errorMessage(err), now);
        console.error(`[worker] github poll failed: ${errorMessage(err)}`);
      }
    }
  } else if (deps.github === null) {
    recordPollError(db, 'github', AGENT_NOT_CONFIGURED, now);
  }
  try {
    enqueueWorkspaceGc(db, config.agent.workspaceRetentionDays, now);
  } catch (err) {
    console.error(`[worker] workspace GC failed: ${errorMessage(err)}`);
  }
```
Make sure `errorMessage` is still imported in `runner.ts`.

- [ ] **Step 6: Wire the agent lane into `src/worker/main.ts`**

Replace the file with:
```ts
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
import { createHostTools } from './agent/host';
import { AgentLane } from './agent/lane';
import { runProcess } from './agent/process';
import { pollOnce, runNextJob } from './runner';

const IDLE_MS = 2_000;

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
  const recovered = recoverRunningJobs(db);
  if (recovered.requeued > 0) console.log(`[worker] Requeued ${recovered.requeued} job(s) left running by a previous crash`);
  if (recovered.failed > 0) console.log(`[worker] Failed ${recovered.failed} crashed job(s) that were out of attempts`);

  const slack = createSlackClient(requireEnv('SLACK_USER_TOKEN'));
  const linear = createLinearClient(requireEnv('LINEAR_API_KEY'));
  const configStore = new ConfigStore(configPath());
  let config: Config | null = null;
  const claude = createClaudeClient({ complete: sdkComplete(() => config?.claude.model ?? null) });

  const githubToken = process.env.GITHUB_TOKEN;
  const ghToken = process.env.GH_TOKEN;
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const agentEnabled = Boolean(githubToken && ghToken && claudeToken);
  const github = agentEnabled ? createGitHubClient(githubToken!) : null;
  if (!agentEnabled) console.log('[worker] Agent workers disabled: GITHUB_TOKEN, GH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN is missing');

  const codeArtifact = new CodeArtifactTokens(runProcess);
  let cachedMap: { dir: string; map: RepoMap } | null = null;
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
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
  console.log(`[worker] stopping (${lane.size} agent run(s) in flight are left to crash recovery)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[worker] crashed', err);
  process.exit(1);
});
```
`repoMap` throws a `PermanentError` when the skill file is missing. The handler that called it then fails the job, with the file path in the message.

- [ ] **Step 7: Extend `.env.op.example`**

Append:
```
# GitHub token for the host (PR verification, status polling, fix inputs). Needs repo + read:org.
GITHUB_TOKEN=op://Private/workflow-github/password
# GitHub token passed into agent containers for clone/push/gh pr create (may be the same item).
GH_TOKEN=op://Private/workflow-github/password
# Claude Code long-lived token for containers. Create with: claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=op://Private/workflow-claude-code/password
```

- [ ] **Step 8: Extend `scripts/smoke.ts`**

Add these imports:
```ts
import { createGitHubClient } from '@/core/clients/github';
import { runProcess } from '@/worker/agent/process';
```
and add these checks to the `results` array, after the Claude check:
```ts
  await check('GitHub', async () => {
    const viewer = await createGitHubClient(process.env.GITHUB_TOKEN ?? '').viewer();
    return `viewer ${viewer.login}`;
  }),
  await check('Podman', async () => {
    const info = await runProcess('podman', ['info', '--format', '{{.Version.Version}}']);
    if (info.exitCode !== 0) throw new Error(info.stderr.trim() || 'podman info failed');
    return `version ${info.stdout.trim()}`;
  }),
  await check('Claude in container', async () => {
    const image = 'workflow-agent:latest';
    if ((await runProcess('podman', ['image', 'exists', image])).exitCode !== 0) return 'skipped (run npm run agent:build-image first)';
    const run = await runProcess(
      'podman',
      ['run', '--rm', '--env', 'CLAUDE_CODE_OAUTH_TOKEN', image, 'claude', '-p', 'Reply with only: ok', '--max-turns', '1'],
      { env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '' }, timeoutMs: 120_000 },
    );
    if (run.exitCode !== 0 || !/ok/i.test(run.stdout)) throw new Error((run.stderr || run.stdout).trim().slice(-300));
    return 'replied ok';
  }),
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/worker/pollers/github.ts src/worker/pollers/github.test.ts src/worker/agent/lane.ts src/worker/agent/lane.test.ts src/worker/runner.ts src/worker/runner.test.ts src/worker/main.ts scripts/smoke.ts .env.op.example
git commit -m "feat: run the agent lane and GitHub poller in the worker" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 16: Read queries and CLI commands

**Files:**
- Modify: `src/core/queries.ts`, `src/cli/program.ts`
- Test: `src/core/queries.test.ts` (extend), `src/cli/program.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `ItemDetail` gains `plans: Plan[]`, `plannedPrs: PlannedPr[]`, `workspace: Workspace | null`, `runs: AgentRun[]` and `activeRun: AgentRun | null`
  - `prRollupsByItem(db): Record<number, PrRollup>`
  - CLI commands: `investigate <id>`, `plan <id> [--json]`, `approve-plan <id>`, `revise-plan <id> <feedback>`, `fix-pr <id> <position>`, `stop-run <id>`, `workspace rm <id>`
  - `buildProgram(db, io, repoMap?: () => RepoMap)` (the default is `loadCurrentRepoMap`)

- [ ] **Step 1: Write the failing tests**

Add to `src/core/queries.test.ts`:
```ts
import { createPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { TEST_REPO_MAP } from '@/test/repo-map';
import { getItemDetail as detailFor, prRollupsByItem } from './queries';

describe('work queries', () => {
  it('includes plans, planned PRs, workspace and runs in item detail, and rolls up PRs per item', () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'implementing' });
    const plan = savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }, { repo: 'web', scope: 'y' }] }, 'claude', null, 0);
    const [first] = createPlannedPrs(db, item, plan, TEST_REPO_MAP, 0);
    updatePlannedPr(db, first!.id, { state: 'open', prNumber: 1, ciState: 'pending', unresolvedThreads: 3 }, 1);

    expect(detailFor(db, item.id)).toMatchObject({
      plans: [{ version: 1 }],
      plannedPrs: [{ position: 1, state: 'open' }, { position: 2, state: 'pending' }],
      workspace: null,
      runs: [],
      activeRun: null,
    });
    expect(prRollupsByItem(db)).toEqual({ [item.id]: { planned: 2, opened: 1, ci: 'pending', unresolved: 3 } });
  });
});
```

Add to `src/cli/program.test.ts` (and change its `run` helper to pass a repo map, as shown):
```ts
import { TEST_REPO_MAP } from '@/test/repo-map';
import { savePlan } from '@/core/work/plans';
import { jobs } from '@/core/db/schema';
import { updateItem } from '@/core/items';

function runWithMap(db: ReturnType<typeof createTestDb>, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram(db, { out: (s) => out.push(s), err: (s) => err.push(s) }, () => TEST_REPO_MAP);
  return program.parseAsync(['node', 'queue', ...args]).then(() => ({ out, err }));
}

describe('work commands', () => {
  it('starts an investigation and approves a plan', async () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1' });
    await runWithMap(db, 'investigate', String(item.id));
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'investigate' }]);

    db.delete(jobs).run();
    updateItem(db, item.id, { workState: 'plan_ready' });
    savePlan(db, item.id, { body: 'b', breakdown: [{ repo: 'core', scope: 'x' }] }, 'claude', null, 1);
    const { out } = await runWithMap(db, 'plan', String(item.id));
    expect(out.join('\n')).toContain('1. `core` — x');
    await runWithMap(db, 'approve-plan', String(item.id));
    expect(db.select().from(jobs).all()).toMatchObject([{ type: 'post-plan' }]);
  });

  it('rejects fix-pr for an unknown position', async () => {
    const db = createTestDb();
    const item = seedItem(db, { linearIssueId: 'i1', linearIdentifier: 'BOO-1', workState: 'prs_open' });
    const { err } = await runWithMap(db, 'fix-pr', String(item.id), '3');
    expect(err.join('')).toContain('has no PR 3');
    process.exitCode = 0;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/queries.test.ts src/cli`
Expected: FAIL, because the detail fields and commands are missing.

- [ ] **Step 3: Extend `src/core/queries.ts`**

Add imports:
```ts
import { type AgentRun, type Plan, type PlannedPr, plannedPrs, type Workspace } from './db/schema';
import { listPlannedPrs, type PrRollup, prRollup } from './work/planned-prs';
import { listPlans } from './work/plans';
import { activeRun, listRuns } from './work/runs';
import { getWorkspace } from './work/workspaces';
```
(merge them into the existing `./db/schema` import). Then replace `ItemDetail` and `getItemDetail`, and add `prRollupsByItem`:
```ts
export type ItemDetail = {
  item: Item;
  drafts: Draft[];
  candidates: DuplicateCandidate[];
  activity: Activity[];
  activeJob: boolean;
  plans: Plan[];
  plannedPrs: PlannedPr[];
  workspace: Workspace | null;
  runs: AgentRun[];
  activeRun: AgentRun | null;
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
    plans: listPlans(db, id),
    plannedPrs: listPlannedPrs(db, id),
    workspace: getWorkspace(db, id) ?? null,
    runs: listRuns(db, id),
    activeRun: activeRun(db, id) ?? null,
  };
}

export function prRollupsByItem(db: Db): Record<number, PrRollup> {
  const byItem = new Map<number, PlannedPr[]>();
  for (const pr of db.select().from(plannedPrs).all()) {
    byItem.set(pr.itemId, [...(byItem.get(pr.itemId) ?? []), pr]);
  }
  return Object.fromEntries([...byItem].map(([itemId, prs]) => [itemId, prRollup(prs)]));
}
```

- [ ] **Step 4: Extend `src/cli/program.ts`**

Change the imports:
```ts
import { Command } from 'commander';
import {
  approve,
  approvePlan,
  discard,
  fixPr,
  link,
  move,
  removeWorkspace,
  retry,
  revise,
  revisePlan,
  startInvestigation,
  stopRun,
} from '@/core/actions';
import type { Db } from '@/core/db/client';
import { CATEGORIES, type Category, type Item } from '@/core/db/schema';
import { ActionError, errorMessage } from '@/core/errors';
import { getItemDetail, listItems } from '@/core/queries';
import { loadCurrentRepoMap } from '@/core/repos/current';
import type { RepoMap } from '@/core/repos/map';
import { listPlannedPrs } from '@/core/work/planned-prs';
import { latestPlan, renderPlanComment } from '@/core/work/plans';
```
Change the signature to `export function buildProgram(db: Db, io: Io, repoMap: () => RepoMap = loadCurrentRepoMap): Command {`, and in `formatItemLine` show the work state when present:
```ts
export function formatItemLine(item: Item): string {
  return [
    `#${item.id}`,
    item.category,
    item.workState ?? item.triageState ?? '-',
    item.linearIdentifier ?? '-',
    item.title || '(untitled)',
  ].join('\t');
}
```
That changes the existing CLI test's expected line only for items that have a `workState`. The existing test seeds none, so it still passes.

Add these commands before `return program;`:
```ts
  program.command('investigate <id>').action(run((id: string) => printItem(startInvestigation(db, parseId(id)))));
  program
    .command('plan <id>')
    .option('--json', 'print JSON')
    .action(
      run((id: string, opts: { json?: boolean }) => {
        const plan = latestPlan(db, parseId(id));
        if (!plan) throw new ActionError(`Item #${id} has no plan`);
        if (opts.json) return io.out(JSON.stringify(plan, null, 2));
        io.out(`Plan v${plan.version} (${plan.author})\n\n${renderPlanComment(plan)}`);
      }),
    );
  program.command('approve-plan <id>').action(run((id: string) => printItem(approvePlan(db, parseId(id), repoMap()))));
  program
    .command('revise-plan <id> <feedback>')
    .action(run((id: string, feedback: string) => printItem(revisePlan(db, parseId(id), feedback))));
  program.command('fix-pr <id> <position>').action(
    run((id: string, position: string) => {
      const itemId = parseId(id);
      const pr = listPlannedPrs(db, itemId).find((p) => p.position === Number(position));
      if (!pr) throw new ActionError(`Item #${itemId} has no PR ${position}`);
      printItem(fixPr(db, itemId, pr.id));
    }),
  );
  program.command('stop-run <id>').action(run((id: string) => printItem(stopRun(db, parseId(id)))));
  program
    .command('workspace')
    .description('Manage agent workspaces')
    .command('rm <id>')
    .action(run((id: string) => printItem(removeWorkspace(db, parseId(id)))));
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/queries.ts src/core/queries.test.ts src/cli/program.ts src/cli/program.test.ts
git commit -m "feat: add work details, PR rollups and agent CLI commands" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 17: Dashboard (work panel, plan editor, PRs, live run, card rollups)

Use the `shadcn` skill for components (the project uses the Base UI variant) and `vercel-react-best-practices` for client/server boundaries.

**Files:**
- Create: `src/lib/work-flags.ts`, `src/app/runs/[id]/route.ts`, `src/components/work-panel.tsx`, `src/components/plan-editor.tsx`, `src/components/prs-panel.tsx`, `src/components/run-panel.tsx`
- Modify: `src/app/actions.ts`, `src/app/page.tsx`, `src/components/item-sheet.tsx`, `src/components/item-card.tsx`, `src/components/board.tsx`, `src/components/status-header.tsx`, `src/lib/format.ts`
- Test: `src/lib/work-flags.test.ts`, `src/lib/format.test.ts` (extend)

**Interfaces:**
- Consumes: Task 16 queries; Task 4 actions.
- Produces:
  - `workFlags(input: { item: Pick<Item, 'category' | 'workState' | 'linearIssueId'>; activeJob: boolean; activeRun: boolean; workspace: Pick<Workspace, 'status'> | null; hasPlan: boolean }): WorkFlags`, where `WorkFlags = { canStart; canEditPlan; canApprove; canRetry; canFix; canStop; canRemoveWorkspace; busy }` (all booleans)
  - `WORK_STATE_LABELS: Record<WorkState, string>`
  - `CI_LABELS: Record<CiState, { symbol: string; label: string }>`
  - Server actions: `startInvestigationAction`, `editPlanAction(itemId, content)`, `revisePlanAction`, `approvePlanAction`, `retryWorkAction`, `fixPrAction(itemId, plannedPrId)`, `stopRunAction`, `removeWorkspaceAction`
  - Route `GET /runs/:id` returns `{ outcome, summary, lines: string[] }`

- [ ] **Step 1: Write the failing tests**

`src/lib/work-flags.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { workFlags } from './work-flags';

const base = {
  item: { category: 'triage' as const, workState: null, linearIssueId: 'i1' },
  activeJob: false,
  activeRun: false,
  workspace: null,
  hasPlan: false,
};

describe('workFlags', () => {
  it('allows starting only with a Linear issue, no work and no job', () => {
    expect(workFlags(base).canStart).toBe(true);
    expect(workFlags({ ...base, item: { ...base.item, linearIssueId: null } }).canStart).toBe(false);
    expect(workFlags({ ...base, activeJob: true }).canStart).toBe(false);
    expect(workFlags({ ...base, item: { ...base.item, category: 'dismissed' } }).canStart).toBe(false);
  });

  it('enables plan editing and approval when the plan is ready', () => {
    const flags = workFlags({ ...base, item: { ...base.item, workState: 'plan_ready' }, hasPlan: true });
    expect(flags).toMatchObject({ canStart: false, canEditPlan: true, canApprove: true });
  });

  it('enables fixing open PRs, stopping a run and removing an idle workspace', () => {
    const flags = workFlags({ ...base, item: { ...base.item, workState: 'prs_open' }, workspace: { status: 'ready' } });
    expect(flags).toMatchObject({ canFix: true, canRemoveWorkspace: true, canStop: false });
    expect(workFlags({ ...base, item: { ...base.item, workState: 'implementing' }, activeJob: true, activeRun: true, workspace: { status: 'ready' } })).toMatchObject({
      canFix: false,
      canStop: true,
      canRemoveWorkspace: false,
      busy: true,
    });
    expect(workFlags({ ...base, item: { ...base.item, workState: 'failed' } }).canRetry).toBe(true);
  });
});
```

Add to `src/lib/format.test.ts`:
```ts
import { CI_LABELS, WORK_STATE_LABELS } from './format';

describe('work labels', () => {
  it('labels every work and CI state', () => {
    expect(WORK_STATE_LABELS.plan_ready).toBe('plan ready');
    expect(CI_LABELS.failure).toEqual({ symbol: '✗', label: 'CI failing' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/work-flags.ts` and extend `src/lib/format.ts`**

`src/lib/work-flags.ts`:
```ts
import type { Item, Workspace } from '@/core/db/schema';

export type WorkFlags = {
  canStart: boolean;
  canEditPlan: boolean;
  canApprove: boolean;
  canRetry: boolean;
  canFix: boolean;
  canStop: boolean;
  canRemoveWorkspace: boolean;
  busy: boolean;
};

export function workFlags(input: {
  item: Pick<Item, 'category' | 'workState' | 'linearIssueId'>;
  activeJob: boolean;
  activeRun: boolean;
  workspace: Pick<Workspace, 'status'> | null;
  hasPlan: boolean;
}): WorkFlags {
  const { item, activeJob, activeRun, workspace, hasPlan } = input;
  const live = item.category !== 'dismissed';
  const idle = live && !activeJob;
  const canEditPlan = idle && item.workState === 'plan_ready';
  return {
    canStart: idle && Boolean(item.linearIssueId) && item.workState === null,
    canEditPlan,
    canApprove: canEditPlan && hasPlan,
    canRetry: idle && item.workState === 'failed',
    canFix: idle && (item.workState === 'implementing' || item.workState === 'prs_open'),
    canStop: live && activeRun,
    canRemoveWorkspace: idle && workspace !== null && workspace.status !== 'removed',
    busy: activeJob,
  };
}
```

Append to `src/lib/format.ts` (and add `CiState` and `WorkState` to its schema type import):
```ts
export const WORK_STATE_LABELS: Record<WorkState, string> = {
  investigating: 'investigating',
  plan_ready: 'plan ready',
  posting_plan: 'posting plan',
  implementing: 'implementing',
  prs_open: 'PRs open',
  failed: 'work failed',
};

export const CI_LABELS: Record<CiState, { symbol: string; label: string }> = {
  none: { symbol: '·', label: 'no checks' },
  pending: { symbol: '…', label: 'CI running' },
  success: { symbol: '✓', label: 'CI passing' },
  failure: { symbol: '✗', label: 'CI failing' },
};
```

- [ ] **Step 4: Add the server actions to `src/app/actions.ts`**

Append (and add `import type { PlanContent } from '@/core/work/plans';` and `import { loadCurrentRepoMap } from '@/core/repos/current';` to the imports):
```ts
export async function startInvestigationAction(itemId: number) {
  return perform(() => actions.startInvestigation(getDb(), itemId));
}
export async function editPlanAction(itemId: number, content: PlanContent) {
  return perform(() => actions.editPlan(getDb(), itemId, content, loadCurrentRepoMap()));
}
export async function revisePlanAction(itemId: number, feedback: string) {
  return perform(() => actions.revisePlan(getDb(), itemId, feedback));
}
export async function approvePlanAction(itemId: number) {
  return perform(() => actions.approvePlan(getDb(), itemId, loadCurrentRepoMap()));
}
export async function retryWorkAction(itemId: number) {
  return perform(() => actions.retryWork(getDb(), itemId));
}
export async function fixPrAction(itemId: number, plannedPrId: number) {
  return perform(() => actions.fixPr(getDb(), itemId, plannedPrId));
}
export async function stopRunAction(itemId: number) {
  return perform(() => actions.stopRun(getDb(), itemId));
}
export async function removeWorkspaceAction(itemId: number) {
  return perform(() => actions.removeWorkspace(getDb(), itemId));
}
```

- [ ] **Step 5: Add the run log route `src/app/runs/[id]/route.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { getDb } from '@/core/db/client';
import { getRun } from '@/core/work/runs';
import { displayLines } from '@/core/work/stream';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(getDb(), Number(id));
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  const lines = existsSync(run.logPath) ? readFileSync(run.logPath, 'utf8').split('\n') : [];
  return NextResponse.json({ outcome: run.outcome, summary: run.summary, lines: displayLines(lines, 30) });
}
```

- [ ] **Step 6: Create the client components**

`src/components/work-panel.tsx`:
```tsx
'use client';

import { removeWorkspaceAction, retryWorkAction, startInvestigationAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Item, Workspace } from '@/core/db/schema';
import { WORK_STATE_LABELS } from '@/lib/format';
import type { WorkFlags } from '@/lib/work-flags';
import { useActionRunner } from './use-action-runner';

export function WorkPanel({ item, workspace, flags }: { item: Item; workspace: Workspace | null; flags: WorkFlags }) {
  const { pending, error, run } = useActionRunner();
  if (!item.linearIssueId) return null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Work</h3>
        {item.workState && (
          <Badge variant={item.workState === 'failed' ? 'destructive' : 'secondary'}>{WORK_STATE_LABELS[item.workState]}</Badge>
        )}
        {flags.canStart && (
          <Button size="sm" disabled={pending} onClick={() => run(() => startInvestigationAction(item.id))}>
            Start investigation
          </Button>
        )}
        {flags.canRetry && (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => retryWorkAction(item.id))}>
            Retry work
          </Button>
        )}
      </div>
      {workspace && workspace.status !== 'removed' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Workspace <span className="font-mono">{workspace.container}</span> · {workspace.status}
            {workspace.repos.length > 0 && ` · ${workspace.repos.join(', ')}`}
          </span>
          {flags.canRemoveWorkspace && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeWorkspaceAction(item.id))}>
              Remove workspace
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
```

`src/components/plan-editor.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { approvePlanAction, editPlanAction, revisePlanAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { BreakdownEntry, Plan } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function PlanEditor({
  itemId,
  plans,
  editable,
  knownRepos,
  posted,
}: {
  itemId: number;
  plans: Plan[];
  editable: boolean;
  knownRepos: string[];
  posted: boolean;
}) {
  const latest = plans.at(-1);
  const [selected, setSelected] = useState<number | null>(null);
  if (!latest) return null;
  const shown = plans.find((p) => p.version === selected) ?? latest;
  const isLatest = shown.version === latest.version;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Implementation plan{posted && ' (posted to Linear)'}</h3>
        <select
          aria-label="Plan version"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={shown.version}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {plans.map((p) => (
            <option key={p.id} value={p.version}>
              v{p.version} by {p.author}
            </option>
          ))}
        </select>
      </div>
      {isLatest && editable ? <PlanForm key={latest.id} itemId={itemId} plan={latest} knownRepos={knownRepos} /> : <PlanView plan={shown} />}
    </section>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="whitespace-pre-wrap">{plan.body}</p>
      <ol className="list-decimal pl-5">
        {plan.breakdown.map((e, i) => (
          <li key={i}>
            <span className="font-mono">{e.repo}</span> — {e.scope}
          </li>
        ))}
      </ol>
      {plan.feedback && <p className="text-muted-foreground">Feedback: {plan.feedback}</p>}
    </div>
  );
}

function PlanForm({ itemId, plan, knownRepos }: { itemId: number; plan: Plan; knownRepos: string[] }) {
  const [body, setBody] = useState(plan.body);
  const [rows, setRows] = useState<BreakdownEntry[]>(plan.breakdown);
  const [feedback, setFeedback] = useState('');
  const { pending, error, run } = useActionRunner();
  const content = { body, breakdown: rows };
  const dirty = body !== plan.body || JSON.stringify(rows) !== JSON.stringify(plan.breakdown);
  const repoOptions = [...new Set([...knownRepos, ...rows.map((r) => r.repo)])].filter(Boolean);
  const setRow = (index: number, patch: Partial<BreakdownEntry>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const moveRow = (index: number, delta: number) =>
    setRows((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="plan-body">Plan</Label>
        <Textarea id="plan-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>PR breakdown</Label>
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 text-sm text-muted-foreground">{i + 1}.</span>
            <select
              aria-label={`Repository for PR ${i + 1}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={row.repo}
              onChange={(e) => setRow(i, { repo: e.target.value })}
            >
              <option value="">Choose repo</option>
              {repoOptions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <Input aria-label={`Scope for PR ${i + 1}`} value={row.scope} onChange={(e) => setRow(i, { scope: e.target.value })} />
            <Button variant="ghost" size="sm" aria-label={`Move PR ${i + 1} up`} onClick={() => moveRow(i, -1)}>
              ↑
            </Button>
            <Button variant="ghost" size="sm" aria-label={`Move PR ${i + 1} down`} onClick={() => moveRow(i, 1)}>
              ↓
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setRows((current) => [...current, { repo: '', scope: '' }])}>
          Add PR
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            run(async () => {
              if (dirty) {
                const saved = await editPlanAction(itemId, content);
                if (saved.error) return saved;
              }
              return approvePlanAction(itemId);
            })
          }
        >
          Approve plan → post & implement
        </Button>
        <Button variant="outline" disabled={pending || !dirty} onClick={() => run(() => editPlanAction(itemId, content))}>
          Save edits
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="plan-feedback">Revise with feedback</Label>
        <Textarea id="plan-feedback" rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={pending || !feedback.trim()} onClick={() => run(() => revisePlanAction(itemId, feedback))}>
          Ask Claude to revise
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
```

`src/components/prs-panel.tsx`:
```tsx
'use client';

import { fixPrAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import type { PlannedPr } from '@/core/db/schema';
import { CI_LABELS } from '@/lib/format';
import { useActionRunner } from './use-action-runner';

export function PrsPanel({ itemId, prs, canFix }: { itemId: number; prs: PlannedPr[]; canFix: boolean }) {
  const { pending, error, run } = useActionRunner();
  if (prs.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Pull requests</h3>
      <ul className="space-y-2">
        {prs.map((pr) => (
          <li key={pr.id} className="space-y-1 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{pr.position}.</span>
              <span className="font-mono">{pr.repoKey}</span>
              {pr.prUrl ? (
                <a className="underline-offset-4 hover:underline" href={pr.prUrl} target="_blank" rel="noreferrer">
                  #{pr.prNumber}
                </a>
              ) : (
                <span className="text-muted-foreground">{pr.state}</span>
              )}
              {pr.state === 'open' && (
                <>
                  <span title={CI_LABELS[pr.ciState].label}>{CI_LABELS[pr.ciState].symbol}</span>
                  <span title="Unresolved review threads">💬 {pr.unresolvedThreads}</span>
                  {pr.isDraft && <span className="text-muted-foreground">draft</span>}
                  {pr.merged && <span className="text-muted-foreground">merged</span>}
                </>
              )}
              {canFix && pr.state === 'open' && (
                <Button size="sm" variant="outline" className="ml-auto" disabled={pending} onClick={() => run(() => fixPrAction(itemId, pr.id))}>
                  Fix with Claude
                </Button>
              )}
            </div>
            <p className="text-muted-foreground">{pr.scope}</p>
            {pr.lastError && <p className="text-destructive">{pr.lastError}</p>}
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
```

`src/components/run-panel.tsx`:
```tsx
'use client';

import { useEffect, useState } from 'react';
import { stopRunAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { useActionRunner } from './use-action-runner';

type RunLog = { outcome: string; summary: string | null; lines: string[] };

export function RunPanel({ itemId, runId, kind, canStop }: { itemId: number; runId: number; kind: string; canStop: boolean }) {
  const [log, setLog] = useState<RunLog | null>(null);
  const { pending, error, run } = useActionRunner();
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`/runs/${runId}`, { cache: 'no-store' });
      if (!cancelled && res.ok) setLog((await res.json()) as RunLog);
    };
    void load();
    const timer = setInterval(load, 3_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId]);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Running: {kind}</h3>
        {canStop && (
          <Button size="sm" variant="destructive" className="ml-auto" disabled={pending} onClick={() => run(() => stopRunAction(itemId))}>
            Stop run
          </Button>
        )}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
        {log?.lines.length ? log.lines.join('\n') : 'Waiting for output…'}
      </pre>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 7: Wire the panels into the sheet and the cards**

In `src/components/item-sheet.tsx`, add these imports:
```ts
import { workFlags } from '@/lib/work-flags';
import { PlanEditor } from './plan-editor';
import { PrsPanel } from './prs-panel';
import { RunPanel } from './run-panel';
import { WorkPanel } from './work-panel';
```
change the props to `{ detail: ItemDetail; closeHref: string; knownRepos: string[] }`, compute after `flags`:
```ts
  const work = workFlags({
    item,
    activeJob: detail.activeJob,
    activeRun: detail.activeRun !== null,
    workspace: detail.workspace,
    hasPlan: detail.plans.length > 0,
  });
```
and render, directly after `<ItemControls … />`:
```tsx
          <WorkPanel item={item} workspace={detail.workspace} flags={work} />
          {detail.activeRun && (
            <RunPanel key={detail.activeRun.id} itemId={item.id} runId={detail.activeRun.id} kind={detail.activeRun.kind} canStop={work.canStop} />
          )}
          <PlanEditor
            itemId={item.id}
            plans={detail.plans}
            editable={work.canEditPlan}
            knownRepos={knownRepos}
            posted={item.planCommentId !== null}
          />
          <PrsPanel itemId={item.id} prs={detail.plannedPrs} canFix={work.canFix} />
```

In `src/components/item-card.tsx`, add the props `rollup?: PrRollup` (type import from `@/core/work/planned-prs`) and import `CI_LABELS`, `WORK_STATE_LABELS`. After the triage badge, render:
```tsx
          {item.workState && (
            <Badge variant={item.workState === 'failed' ? 'destructive' : 'outline'}>{WORK_STATE_LABELS[item.workState]}</Badge>
          )}
          {rollup && rollup.planned > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {rollup.opened}/{rollup.planned} PRs
              </span>
              {rollup.ci !== 'none' && <span title={CI_LABELS[rollup.ci].label}>{CI_LABELS[rollup.ci].symbol}</span>}
              {rollup.unresolved > 0 && <span title="Unresolved review threads">💬 {rollup.unresolved}</span>}
            </div>
          )}
```

In `src/components/board.tsx`, add the prop `rollups: Record<number, PrRollup>` and pass `rollup={rollups[item.id]}` to each `ItemCard`.

In `src/components/status-header.tsx`, change `SOURCES` to `['slack', 'linear', 'github', 'config'] as const`.

In `src/app/page.tsx`, import `prRollupsByItem` from `@/core/queries` and `knownRepoKeys` from `@/core/repos/current`. Pass `rollups={prRollupsByItem(db)}` to `<Board>` and `knownRepos={knownRepoKeys()}` to `<ItemSheet>`.

- [ ] **Step 8: Run tests, typecheck and build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS; tsc clean; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/lib src/app src/components
git commit -m "feat: add work, plan, PR and live run panels to the dashboard" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```

---

### Task 18: Demo data, browser verification, README and live smoke

Use the `example-skills:webapp-testing` skill. Chromium works on this machine.

**Files:**
- Modify: `scripts/seed-demo.ts`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: demo items covering every work state, and a documented setup for agent workers.

- [ ] **Step 1: Extend `scripts/seed-demo.ts`**

Append before the final `console.log`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { enqueueJob, claimNextJob } from '@/core/jobs/queue';
import { createPlannedPrs, updatePlannedPr } from '@/core/work/planned-prs';
import { savePlan } from '@/core/work/plans';
import { startRun } from '@/core/work/runs';
import { createWorkspaceRow, updateWorkspace } from '@/core/work/workspaces';
import type { RepoMap } from '@/core/repos/map';

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
const runningJob = claimNextJob(db, now)!;
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
```
Merge these imports with the existing ones at the top of the file (`items`, `upsertLinearItem`, `defaultDbPath` and `db` already exist there). Add `import { eq } from 'drizzle-orm';` if it isn't imported yet.

- [ ] **Step 2: Verify the dashboard in a real browser**

Run:
```bash
rm -f data/demo.db data/demo.db-wal data/demo.db-shm
WORKFLOW_DB=data/demo.db npm run seed:demo
WORKFLOW_DB=data/demo.db npm run dev:web
```
(Run the server in the background. Never re-seed while it's running: stop it, delete `data/demo.db*`, seed, then start it again.)

With the webapp-testing skill (Playwright), check each point and take screenshots:
1. The board shows BOO-1430 in Triage with the `plan ready` work badge. BOO-1503 is in In Progress, showing `1/2 PRs`, `✗` and `💬 2`. The header shows `github: …`.
2. Open BOO-1430. The sheet shows the Work panel with `plan ready`, the plan body, two breakdown rows with repo selects (`mp-core`, `mp_dashboard`), **Approve plan → post & implement** and **Ask Claude to revise**.
3. Edit the second scope and click **Save edits**. After the refresh, the version picker shows `v2 by user`.
4. Click **Approve plan**. The work badge changes to `posting plan`, and the plan becomes read-only.
5. Open BOO-1503. The Running panel shows `💬 Reading DatePicker.tsx` and a `🔧 Read …` line, plus **Stop run**. The PRs panel shows `#4821` with `✗`, `💬 2` and `draft`.
6. Click **Stop run**. The activity list shows "Stop requested for implement-pr".
7. Close the sheet with Escape. Collect browser console errors; there must be none.

Stop the server and delete `data/demo.db*`, `data/runs/demo-*` and any generated `AGENTS.md`.

- [ ] **Step 3: Update `README.md`**

Add a section after `## Config`:
```markdown
## Agent workers (investigation and implementation)

Agent workers run Claude Code inside a per-issue Podman container (`wf-<issue>`), so code changes never touch your machine.

1. Install Podman (rootless) and build the image: `npm run agent:build-image`.
2. Create a long-lived Claude Code token with `claude setup-token` and store it in 1Password.
3. Add `GITHUB_TOKEN`, `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` references to `.env.op` (see `.env.op.example`). The GitHub token needs repo access to the repositories you work on.
4. Make sure `~/.claude/skills/meetingpackage` (repo map) and `~/.claude/skills/github` exist. For repos that install from AWS CodeArtifact, run `aws sso login --profile <profile>` when prompted.
5. `npm run smoke` checks GitHub, Podman and Claude inside the container.

Flow:
- On an item with a Linear issue, click **Start investigation** (or `npm run queue -- investigate <id>`, or a rule with `action: start-investigation`).
- Review the plan and its PR breakdown, edit or revise it, then **Approve plan**. The plan is posted as a Linear comment and implementation starts.
- One draft PR is opened per breakdown row, in order. When all are open, the item moves to Verification.
- PR cards and the sheet show CI and unresolved review threads. **Fix with Claude** runs one fix round for a PR.
- **Stop run** kills the current run. **Retry work** resumes a failed step. Workspaces are removed 7 days after an item is done or dismissed, or with **Remove workspace**.
```

In `CLAUDE.md`, replace the line that starts with `Sub-projects 1–3` with:
```
Sub-projects 1–4 (queue core, ingestion, 👀 triage, investigation/implementation workers) are implemented; see README.md. Next: verification worker (sub-project 5).
```

- [ ] **Step 4: Run the full suite, then the live checks**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

Then run `npm run test:podman` and `npm run smoke`. These need the user's 1Password references for the three new secrets. If those references aren't in `.env.op` yet, report the exact ✗ lines; don't create secrets.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-demo.ts README.md CLAUDE.md
git commit -m "docs: document agent workers and seed demo work states" -m "Co-Authored-By: <your model name> <noreply@anthropic.com>"
```
