# Queue core, ingestion and 👀 triage — design

Date: 2026-10-10
Status: approved in brainstorming, pending written-spec review

## 1. Context and goal

`workflow` is a personal, local, single-user tool that collects work from Slack and Linear into one queue and moves each item through categories: **Triage → In Progress → Verification → Done**. Claude does the heavy lifting; the user approves at key points.

The full vision has five sub-projects:

1. Core: queue, categories, config, SQLite, dashboard, CLI
2. Ingestion: Slack reactions and Linear status/label changes → queue items via config rules
3. Triage flow (👀): Claude duplicate check → in-app draft → approve → Linear issue
4. Investigation and implementation workers, plan comment, PR/CI tracking
5. Verification worker

**This spec covers sub-projects 1–3.** Sub-projects 4–5 get their own specs later.

### Success criteria

- Reacting 👀 to a Slack message causes, within about two minutes, a Triage item that shows either a suspected duplicate Linear issue or a draft issue.
- The user can link a duplicate, or edit, revise, approve or discard a draft from the dashboard or the CLI.
- Approving creates exactly one Linear issue in the default team. The description holds only the problem and the acceptance criteria, and the Slack thread is attached.
- Linear issues assigned to or created by the user that match a config rule (for example status `Triage`) show up in the matching category.
- Editing `workflow.config.yaml` changes behaviour without a restart.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Event delivery | Polling (Slack user token + Linear API). No webhooks, no public URL |
| Claude access | Claude Agent SDK using the existing Claude Code login. No API key |
| Duplicate search | The app searches Linear, and Claude judges the candidates. Claude gets no tools |
| Duplicate found | The user confirms in the UI. Linking attaches the Slack permalink to the existing issue |
| Draft review | Direct edit, plus "revise with feedback" (Claude rewrites) |
| Target team | One default team from config |
| Linear scope | Issues assigned to or created by the user |
| Architecture | One repo, separate `web` and `worker` processes plus a CLI, sharing SQLite and a `core` library |

### Assumptions

- PR hosting (GitHub) only matters in sub-project 4. No GitHub integration here.
- The investigation/implementation plan comment, and the user's approval of it, belong to sub-project 4.
- Localhost only, with no authentication.

## 2. Architecture

```
            ┌───────────── core/ (shared library) ─────────────┐
            │ db · config · rules · triage machine · actions ·  │
            │ jobs queue · clients (slack, linear, claude)      │
            └───────▲──────────────────▲──────────────────▲─────┘
                    │                  │                  │
   web (Next.js) ───┘    worker (Node) ┘       cli (Node) ┘
   reads queue,          pollers + job        same actions as UI,
   writes via actions    handlers; only       --json output
   (no external calls)   process calling
                         Slack/Linear/Claude
                    all share data/workflow.db (SQLite, WAL)
```

- **web:** Next.js App Router + shadcn/ui. Server Actions call `core/actions`, which only write rows and enqueue jobs.
- **worker:** a long-running `tsx` process. It runs both pollers on an interval and processes the `jobs` table one job at a time.
- **cli:** `pnpm queue …`, a thin wrapper over `core/actions`.
- `pnpm dev` starts web and worker together (`concurrently`).

## 3. Data model (SQLite + Drizzle)

| Table | Purpose / key columns |
|---|---|
| `items` | `id`, `category` (`triage \| in_progress \| verification \| done \| dismissed`), `triage_state`, `title`, `slack_channel`, `slack_thread_ts`, `slack_permalink`, `linear_issue_id`, `linear_identifier`, `linear_url`, `last_error`, `created_at`, `updated_at`. Unique on (`slack_channel`, `slack_thread_ts`) and on `linear_issue_id` |
| `source_events` | `id`, `item_id`, `source` (`slack \| linear`), `kind`, `external_key` (**unique**), `payload` (JSON), `seen_at` |
| `drafts` | `id`, `item_id`, `version`, `title`, `problem` (markdown), `acceptance_criteria` (JSON string[]), `author` (`claude \| user`), `feedback`, `created_at` |
| `duplicate_candidates` | `id`, `item_id`, `linear_issue_id`, `linear_identifier`, `title`, `url`, `confidence`, `reasoning` |
| `jobs` | `id`, `type`, `item_id`, `payload` (JSON), `status` (`queued \| running \| done \| failed`), `attempts`, `run_after`, `started_at`, `last_error`, timestamps |
| `poll_cursors` | `source` (PK), `cursor`, `last_success_at`, `last_error` |
| `linear_issue_snapshots` | `issue_id` (PK), `status_name`, `label_names` (JSON), `updated_at` |
| `activity` | `id`, `item_id`, `message`, `created_at` (timeline shown in the UI) |

**Identity:** there is one item per Slack thread, keyed by the root `thread_ts` (or by `ts` when the message is not in a thread), and one per Linear issue. When a Slack item creates or links a Linear issue, the item stores that issue. Later Linear events for the issue update the same item.

### Triage state machine

`triage_state` values: `new`, `checking_duplicates`, `duplicate_suspected`, `drafting`, `draft_ready`, `creating_issue`, `linked`, `failed`. It is null for items that never went through the 👀 flow.

| From | Trigger | To |
|---|---|---|
| `new` | `triage-draft` job starts | `checking_duplicates` |
| `checking_duplicates` | candidate ≥ threshold | `duplicate_suspected` |
| `checking_duplicates` | no candidate ≥ threshold | `drafting` (enqueue `draft`) |
| `duplicate_suspected`, `draft_ready` | user: Link | `linked` (after `link-linear-issue`) |
| `duplicate_suspected` | user: Not a duplicate | `drafting` |
| `drafting` | `draft` job succeeds | `draft_ready` |
| `draft_ready` | user: Edit | `draft_ready` (new draft version, author `user`) |
| `draft_ready` | user: Revise with feedback | `drafting` |
| `draft_ready` | user: Approve | `creating_issue` |
| `creating_issue` | `create-linear-issue` succeeds | `linked` |
| any non-terminal | user: Discard | category `dismissed` |
| any job-driven state | job fails permanently | `failed` (`last_error` set) |
| `failed` | user: Retry | the state the failed job started from; the job is re-enqueued |

The machine is a pure function: `transition(state, event) → { state, effects[] }`. Invalid transitions return an error, and actions show that error to the caller.

**Categories:** config rules set the category when an event arrives. The user can also move an item manually (UI or CLI). Automatic moves to In Progress and Verification are out of scope. Those categories exist so the board is complete.

## 4. Configuration

`workflow.config.yaml` in the repo root, validated with zod:

```yaml
linear:
  defaultTeam: ENG
slack:
  pollIntervalSeconds: 60
  backfillOnFirstRun: false
claude:
  model: null                 # null = Claude Code default
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

- `when` matchers: `source` (required), plus exactly one of `reaction` (Slack reaction name), `status` (Linear status name) or `label` (Linear label name added).
- **The first matching rule in file order wins.**
- `action` is optional. The only valid value in this sub-project is `triage-draft`, and it is allowed only on Slack rules.
- The worker re-reads the file at the start of each poll cycle. If the file is invalid, the worker logs the error, records it in `poll_cursors.last_error` (shown in the header) and keeps the last valid config.
- Secrets live in `.env` (`SLACK_USER_TOKEN`, `LINEAR_API_KEY`). `.env.example` is committed.

## 5. Ingestion

### Slack poller

- Calls `reactions.list` (user token, `full=true`) and pages until a page contains only already-seen keys.
- Turns each (message, reaction made by the user) pair into a `source_event` with `external_key = slack:<channel>:<ts>:<reaction>`. A duplicate key is a no-op.
- **First run** (no cursor): records all current reactions as seen without matching rules, unless `backfillOnFirstRun: true`.
- New events go through the rules engine. On a match, the poller upserts the item for the thread, sets its category, and enqueues the rule's action (if any) with `triage_state = new`.
- Reaction removal is ignored.

### Linear poller

- A GraphQL query fetches issues with `updatedAt > cursor` where the assignee or creator is the viewer. It paginates and then advances the cursor to the maximum `updatedAt` seen.
- Each issue is compared with `linear_issue_snapshots`, which yields `status_changed(newStatus)` and `label_added(label)` events with `external_key = linear:<issueId>:status:<name>:<updatedAt>` and `linear:<issueId>:label:<name>:<updatedAt>`. Then the snapshot is updated.
- An issue with no snapshot (including on the first run) emits its current status and all current labels as events.
- Matching events upsert the item for the issue and set its category.

### Rules engine

`match(event, rules) → { category, action? } | null`. A pure function. Events with no match are stored and change nothing.

## 6. Claude integration and the triage jobs

### Claude client

- `@anthropic-ai/claude-agent-sdk` with no tools allowed, `claude.model` from config, and the prompt loaded from `prompts/<name>.md` with variables filled in.
- Output is parsed as JSON and validated with a zod schema. If validation fails, the call is retried once with the validation error appended. A second failure is a permanent job failure.
- Interface: `claude.run<T>(promptName, vars, schema): Promise<T>`. It is faked in tests.

### `triage-draft` job

1. **Gather:** `conversations.replies` for the thread (text, author names, file names) and `chat.getPermalink`. Store the permalink. Set `items.title` to the first line of the root message (truncated to 120 characters).
2. **Search terms:** run the `search-terms` prompt, which returns `{ queries: string[] }` (1–3 items).
3. **Search Linear:** run `searchIssues` for each query in the default team. Keep open issues and issues closed within `searchClosedWithinDays`. Deduplicate by id and keep at most `maxCandidates`. If there are no candidates, go to step 5.
4. **Assess:** run the `assess-duplicates` prompt with the thread and the candidates. It returns `{ duplicates: { identifier, confidence (0–1), reasoning }[] }`. Store the candidates with `confidence ≥ duplicateThreshold`. If any are stored, move to `duplicate_suspected`. If none are, continue.
5. Move to `drafting` and enqueue a `draft` job.

### `draft` job

- Inputs: the thread, plus (when revising) the latest draft and the user's feedback.
- The `draft` prompt returns `{ title, problem, acceptanceCriteria: string[] }`. The prompt tells Claude to describe **only the observable problem and the acceptance criteria**, with no root-cause guesses, solutions or plans.
- Stores a new `drafts` row (author `claude`, with the feedback recorded) and moves to `draft_ready`.

### `create-linear-issue` job

1. **Idempotency check:** call `attachmentsForURL(slack_permalink)`. If the URL is already attached to an issue, record that issue and move to `linked`.
2. Otherwise call `issueCreate` in the default team with the title and this description:
   ```
   ## Problem
   <problem>

   ## Acceptance criteria
   - [ ] <criterion>
   ```
3. Call `attachmentLinkURL(issueId, slack_permalink, title: "Slack thread")`.
4. Record `linear_issue_id`, `linear_identifier` and `linear_url` and move to `linked`.

### `link-linear-issue` job

Resolves the issue from its identifier when the payload has no id (the CLI path), calls `attachmentLinkURL` on it, records the issue on the item, and moves to `linked`.

## 7. Jobs queue and error handling

- The worker claims one `queued` job with `run_after ≤ now` and marks it `running` in a single transaction.
- **Transient errors** (network failures, 5xx, 429) are rescheduled with exponential backoff (30 s, 2 min, 10 min) and respect `Retry-After`. The job gets at most 3 attempts.
- **Permanent failures** (out of attempts, invalid Claude output after the retry, 4xx other than 429) mark the job `failed`. The item moves to `triage_state = failed` with `last_error` set, and an activity entry is written.
- **Crash recovery:** when the worker starts, any job that has been `running` for more than 15 minutes is set back to `queued`.
- Poller errors are stored in `poll_cursors.last_error`. The cursor does not advance, so the next cycle retries the same window.

## 8. Dashboard

- **Board:** columns for Triage, In Progress, Verification and Done. A filter shows dismissed items.
- **Card:** source icon, title, triage-state badge, Linear identifier and age.
- **Item sheet:**
  - Slack thread preview and permalink.
  - Duplicate panel: candidates with reasoning, plus **Link** and **Not a duplicate**.
  - Draft editor: title, problem (markdown) and an acceptance-criteria list editor, with a version picker, a **Revise with feedback** box, **Approve → create in Linear** and **Discard**.
  - Activity timeline, the error with **Retry** for failed items, and **Move to…**.
- **Header:** last successful poll per source and the last poll error, plus queued and failed job counts.
- **Refresh:** a client component calls `router.refresh()` every 5 seconds.
- All mutations go through Server Actions → `core/actions`.

## 9. CLI

```
pnpm queue list [--category <c>] [--json]
pnpm queue show <id> [--json]
pnpm queue move <id> <category>
pnpm queue approve <id>
pnpm queue discard <id>
pnpm queue retry <id>
pnpm queue link <id> <LINEAR-IDENTIFIER>
pnpm queue revise <id> "<feedback>"
```

The CLI exits non-zero and prints an error when a transition is invalid. Like the UI, the CLI never calls external APIs. `queue link` enqueues a `link-linear-issue` job that carries the identifier, and the worker resolves it to an issue id. Linking is allowed from `duplicate_suspected` and `draft_ready`.

## 10. Project layout

```
src/
  core/
    db/          schema.ts, client.ts, migrations/
    config/      schema.ts, load.ts
    rules/       match.ts
    triage/      machine.ts
    actions/     approve.ts, discard.ts, link.ts, move.ts, revise.ts, edit-draft.ts, retry.ts
    jobs/        queue.ts
    clients/     slack.ts, linear.ts, claude.ts
  worker/
    pollers/     slack.ts, linear.ts
    handlers/    triage-draft.ts, draft.ts, create-linear-issue.ts, link-linear-issue.ts
    main.ts
  cli/main.ts
  app/           Next.js routes and components
prompts/         search-terms.md, assess-duplicates.md, draft.md
scripts/smoke.ts
workflow.config.yaml
.env.example
data/            (gitignored) workflow.db
```

## 11. Testing

Test-driven with Vitest.

- **Pure units:** `rules/match`, `triage/machine`, Linear snapshot diffing, Slack key building and first-run handling, the config schema, and backoff calculation.
- **Core with real SQLite:** each test gets a temporary database file. Covers actions, jobs queue claiming, retries and stuck-job recovery, and pollers using fake clients. Polling the same data twice must create no new events, items or jobs.
- **Handlers with fake clients:** duplicate path, no-candidate path, revision path, malformed Claude JSON (one retry, then failed), and the idempotent `create-linear-issue` retry (an existing attachment links the issue instead of creating a new one).
- **No live API calls in the test suite.** `pnpm smoke` checks real credentials separately: Slack `auth.test`, Linear `viewer`, and one minimal Claude call.
- **UI:** webapp-testing (Playwright) against the dev server with a seeded database: open an item, edit a draft, approve it (job enqueued), and use the duplicate panel's Link button.

## 12. Out of scope

Investigation, implementation and verification workers; the plan comment; PR and CI tracking; GitHub integration; automatic moves to In Progress or Verification; handling reaction removal; authentication; deployment; rule actions other than `triage-draft`.
