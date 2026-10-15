# Investigation and implementation workers — design

Date: 2026-10-15
Status: approved in brainstorming, pending written-spec review
Builds on: `2026-10-10-queue-triage-design.md` (sub-projects 1–3, implemented)

## 1. Goal

Sub-project 4 of `workflow`. Once a Linear issue exists for a queue item, Claude:

1. **investigates** the code and drafts an implementation plan, which the user reviews in the app;
2. after the user **approves**, posts the plan as a Linear comment;
3. **implements** the plan as one draft PR per planned breakdown entry;
4. while PRs are open, the app shows each PR's CI and review status, and the user can ask Claude to **fix** a PR.

When every planned PR is open, the item moves to **Verification**. The Verification worker itself is sub-project 5.

### Success criteria

- **Start investigation** on any item with a Linear issue produces a reviewable plan (body plus PR breakdown) within the investigation timeout. The investigation never pushes code and never receives a GitHub token.
- **Approve plan** posts exactly one Linear comment, moves the item to In Progress and starts implementation.
- Implementation opens one **draft** PR per breakdown entry, in order. Branches are named `{team}-{number}-{slug}`, commits carry the user's git identity, and nothing carries AI trailers or branding.
- The In Progress card shows `opened/planned PRs`, an aggregate CI state, and the unresolved review thread count, refreshed from GitHub every `agent.prPollSeconds`.
- **Fix with Claude** on a PR runs one fix round against that PR's unresolved threads and failing checks.
- A 40-minute implementation run never blocks 👀 triage or polling.
- All code-executing agent runs happen inside a per-item **Podman** container.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Starting investigation | Explicit only: a button, the CLI, or a config rule (`action: start-investigation` on Linear rules) |
| Starting implementation | Approving the plan posts the comment and starts implementation |
| PR structure | The plan ends with an explicit breakdown `[{repo, scope}]`; one PR per entry, in order. "All PRs created" means every entry has an open PR |
| After PRs open | Show-only. Status is polled. **Fix with Claude** runs one fix round per click. No automatic fix loops, no merging |
| Isolation | Claude Code runs **inside** a per-item Podman container (`podman exec … claude -p`). Not Docker |
| Concurrency | A separate agent job lane with `agent.maxConcurrent` (default 1). The existing lane keeps triage and polling going |

### Reused external assets (read at runtime, not copied into this repo)

- `~/.claude/skills/meetingpackage`: `config/repositories.json` (repo keys, GitHub repos, tool versions, install and validation commands, env targets) and `scripts/detect-repository.sh`.
- `~/.claude/skills/docker/scripts/sync-env.sh`: syncs app env files from 1Password. Only this script is reused; the rest of the `docker` skill (Docker-specific) is not used and not changed.
- `~/.claude/skills/github` and `~/.claude/skills/meetingpackage`: copied into the container's `~/.claude/skills` so Claude inside follows the same house rules.

## 2. Lifecycle and data model

### Work state

A new item column `work_state`, independent of `triage_state`:

```
null ─[Start investigation]→ investigating → plan_ready
plan_ready ─[Edit]→ plan_ready (new plan version, author user)
           ─[Revise with feedback]→ investigating
           ─[Approve plan]→ posting_plan → implementing      (category → in_progress)
implementing → prs_open                                     (all planned PRs open; category → verification)
investigating | posting_plan | implementing → failed        (last_error set; Retry → state the job started from)
```

- **Start investigation** requires `linear_issue_id` and `work_state` ∈ {null}.
- Dismissal and re-arming follow the existing rules. Triage actions already refuse dismissed items, and leaving `dismissed` re-arms an interrupted job. Both extend to the work jobs (`investigate`, `post-plan`, `implement-pr`).
- A permanent `fix-pr` failure does **not** fail the item. It sets `last_error` and logs activity, like failed link jobs.
- `work_state` gets its own pure transition function, `work/machine.ts`, with the same `{ ok, state } | { ok: false, error }` shape as the triage machine. Actions and handlers apply it through a `applyWorkEvent` helper.
- Items also get a `work_failed_from_state` column, so Retry knows where to resume.

### New tables

| Table | Columns |
|---|---|
| `plans` | `id`, `item_id`, `version`, `body` (markdown), `breakdown` (JSON `[{ repo, scope }]`, order = array order), `author` (`claude \| user`), `feedback`, `created_at`. Unique (`item_id`, `version`) |
| `planned_prs` | `id`, `item_id`, `plan_version`, `position` (1-based), `repo_key`, `github_repo` (`owner/name`), `scope`, `branch`, `pr_number`, `pr_url`, `state` (`pending \| implementing \| open \| failed`), `is_draft`, `merged`, `unresolved_threads`, `ci_state` (`none \| pending \| success \| failure`), `polled_at`, `last_error`. Unique (`item_id`, `position`) |
| `workspaces` | `item_id` (PK), `container`, `volume`, `image`, `status` (`creating \| ready \| broken \| removed`), `repos` (JSON list of cloned repo keys), `created_at`, `last_used_at` |
| `agent_runs` | `id`, `job_id`, `item_id`, `planned_pr_id`, `kind` (`investigate \| implement-pr \| fix-pr`), `started_at`, `ended_at`, `outcome` (`running \| succeeded \| failed \| timed_out \| stopped`), `summary`, `log_path` |

`items` gains `work_state`, `work_failed_from_state` and `plan_comment_id` (the Linear comment UUID, set when the plan is approved).

### New job types

The agent lane runs `prepare-workspace`, `investigate`, `implement-pr`, `fix-pr` and `remove-workspace`. The core lane runs `post-plan`.

Payloads:
- `investigate { feedback?: string }`
- `post-plan { commentUuid: string }`
- `implement-pr { plannedPrId: number }`
- `fix-pr { plannedPrId: number }`
- `prepare-workspace { repos: string[] }`
- `remove-workspace {}`

## 3. Workspaces (Podman)

### Image

`containers/agent/Containerfile` builds `workflow-agent:latest` from Debian with:
- Node 24
- git, gh, jq, curl, python3, build-essential
- the `claude` CLI (npm global)
- `mise`, for installing per-repo tool versions on demand

The worker builds the image when it's missing. `npm run agent:build-image` rebuilds it.

### Container engine

Config: `agent.containerEngine` (default `podman`). All engine calls go through a `ContainerEngine` interface:
- `ensureImage()`
- `ensureWorkspace(itemKey)` (create the volume and container if missing; start the container if stopped)
- `exec({ container, workdir, env, args, timeoutMs, signal, onLine })`, which returns the exit code
- `copyInto(container, hostPath, containerPath)`
- `remove(itemKey)`

`PodmanEngine` implements it with the `podman` CLI. Env values are passed with `--env KEY` reading from the child-process environment, never as `KEY=value` arguments, so secrets don't appear in process listings.

### Per-item workspace

- **Names:** container and volume `wf-<identifier-lowercase>`, for example `wf-boo-1430`. The volume is mounted at `/work`.
- **Container:** started with `sleep infinity`, as an unprivileged in-container user with `HOME=/home/agent`.
- **`prepare-workspace` job:** runs before the first investigation, and again when a later plan adds repos.
  1. Ensure the image, the volume and the container.
  2. Copy the `github` and `meetingpackage` skills into `/home/agent/.claude/skills`.
  3. Set git `user.name` and `user.email` from the host's `git config --global`.
  4. For each repo:
     - `git clone` into `/work/<repo_key>`. Uses `GH_TOKEN` for this step only.
     - `mise install` the repo's tool versions from the map.
     - Run the repo's install command from the map.
     - If the repo has an env target and `agent.syncEnv` is true, run `sync-env.sh` on the host into a temp dir, `podman cp` the files in, then delete the temp dir.
  5. Mark the workspace `ready`. Any failure marks it `broken`, and the next run rebuilds the workspace.
- **Repo detection for the first investigation:** run `detect-repository.sh` on the issue JSON. If it returns nothing, use `agent.defaultRepos` from config. If that is empty too, fail the job with "no repository detected; add one to the plan manually".

### Credentials

Resolved from 1Password through `with-secrets.sh` into the worker's environment, and passed per `exec`:

| Variable | Used by | Passed into |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude inside the container (created once with `claude setup-token`) | every agent run |
| `GH_TOKEN` | git push and `gh pr create` inside the container | `prepare-workspace` clones, `implement-pr` and `fix-pr` only. **Never `investigate`** |
| `GITHUB_TOKEN` | the host GitHub client (poller, PR verification, fix inputs) | not passed into the container |

`.env.op.example` gains the three references. `GH_TOKEN` and `GITHUB_TOKEN` may point to the same 1Password item.

**AWS CodeArtifact (private npm registry).** Some repos (`mp-core`, `mp_dashboard`) install packages from CodeArtifact, using the repo's `awsProfile` from the map (falling back to `defaults.awsProfile`). AWS credentials **never** enter the container.
- Before each install-capable exec (`prepare-workspace`, `implement-pr`, `fix-pr`) for a repo with an `awsProfile`, the worker runs `aws codeartifact get-authorization-token --domain <codeArtifactDomain> --domain-owner <awsAccountId> --region <awsRegion> --profile <awsProfile> --query authorizationToken --output text` on the host. The token is short-lived (about 12 h) and cached in memory until 30 minutes before it expires.
- The token is passed into the exec as `CODEARTIFACT_AUTH_TOKEN`. A small in-container step writes `~/.npmrc` (`//<registry host+path>/:_authToken=${token}`) and `~/.yarnrc.yml` (`npmRegistries` entry for `defaults.codeArtifactRegistry` with `npmAuthToken` and `npmAlwaysAuth: true`) before the command, and deletes both files after it, so the token is not left on disk in the workspace.
- Investigation runs never receive the token.
- If the host `aws` call fails (expired SSO session, missing profile), the job fails permanently with the AWS error and a hint to run `aws sso login --profile <awsProfile>`.

### Cleanup

The `workspace-gc` step runs on each poll cycle. It removes the container and volume of items that have been `done` or `dismissed` for more than `agent.workspaceRetentionDays` days (default 7). A **Remove workspace** action (UI and CLI) removes them immediately; it is refused while an agent run is active for the item.

## 4. Agent runs

### Agent lane

The worker runs two loops over the same `jobs` table:
- The **core lane** is the existing loop. It claims every job type except the agent ones.
- The **agent lane** claims only `prepare-workspace`, `investigate`, `implement-pr`, `fix-pr` and `remove-workspace`, keeping up to `agent.maxConcurrent` (default 1) handler promises in flight.

`claimNextJob` takes a list of allowed types. Claiming stays atomic: one immediate transaction.

### Invocation

```
podman exec -w /work --env CLAUDE_CODE_OAUTH_TOKEN [--env GH_TOKEN] wf-<key> \
  claude -p <prompt> --output-format stream-json --verbose --max-turns <N> [tool flags]
```

- **Logging:** every stdout line is appended to `data/runs/<run_id>.jsonl`. `agent_runs` tracks the run.
- **Final result:** the last `result` event's text must contain a JSON object, extracted with the existing `extractJson`. It is validated with a zod schema per run kind. If it is invalid, the run is resumed **once** (`claude -p --resume <session_id>`) with the validation error. A second failure is permanent.
- **Timeouts:** `agent.timeoutMinutes.investigate` (default 20) and `agent.timeoutMinutes.implement` (default 60, also used for fix-pr).
- **Stop run:** a timeout or a Stop run kills the exec (SIGTERM, then SIGKILL after 10 s). The job fails **permanently**; expensive runs are never retried automatically. The outcome is `timed_out` or `stopped`.
- **Error classification:**
  - A non-zero exit of `podman exec` itself (container missing, engine error) is transient, and the workspace is marked `broken`.
  - Claude ending with an error result is permanent.
- **Turn limits:** `--max-turns` defaults to 60 for investigate and 200 for implement or fix. They are configurable.

### Run kinds

**`investigate`**
- **Tools:** `--allowedTools "Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git diff:*),Bash(ls:*)"`. No Edit or Write. No `GH_TOKEN` in env (a test asserts this).
- **Prompt input:**
  - the issue identifier, title and description
  - the Slack thread, if the item has one
  - the repo list and paths
  - for a revision: the latest plan and the user's feedback
- **Instructions:**
  - Read the code.
  - Describe findings, the approach and the risks.
  - Split the work into the smallest sensible ordered PRs, each scoped to one repo.
  - Don't restate the problem; the issue description already holds it.
- **Output:** `{ body: string, breakdown: [{ repo: string, scope: string }] }`, with at least one entry. Every `repo` must be a key in the meetingpackage map; unknown keys fail validation, which triggers the resume-once path.
- **On success:**
  - Save a new `plans` version authored by claude.
  - `work_state` → `plan_ready`.
  - If the breakdown names repos that are not cloned yet, enqueue `prepare-workspace` for them. As a safety net, `implement-pr` also runs the same per-repo prepare steps for its own repo when that repo is missing from `workspaces.repos`, so ordering between jobs doesn't matter.

**`implement-pr`** (one job per planned PR, run in `position` order)
- **Tools:** full tool access inside the container (`--dangerously-skip-permissions`; acceptable only because of the sandbox). `GH_TOKEN` in env.
- **Prompt input:**
  - the issue
  - the approved plan body
  - this PR's position, repo and scope
  - the list of already-opened PRs with their URLs
  - the repo's validation commands from the map
- **Instructions:**
  - Fetch and branch from the default branch as `{team}-{number}-{slug}`.
  - Implement only this scope.
  - Run the validation commands.
  - Commit with no AI trailers.
  - Push.
  - Open a **draft** PR whose body links the Linear issue and lists the earlier PRs.
- **Output:** `{ prNumber: number, prUrl: string, branch: string, summary: string }`.
- **Verification:** the worker fetches the PR through the host GitHub client. It must exist in `github_repo`, be open, and have head branch = `branch`.
- **Then:** the planned PR → `open` with the PR fields. Next:
  - if pending PRs remain, enqueue `implement-pr` for the next position;
  - otherwise `work_state` → `prs_open` and `category` → `verification`.
- **Failure:** the planned PR → `failed` with `last_error`; the item → `failed` (`work_failed_from_state = implementing`). **Retry** re-enqueues `implement-pr` for that planned PR only.
- **Idempotency on retry:** if `branch` is already recorded and an open PR exists for it, the job marks the PR `open` without running Claude again.

**`fix-pr`** (the **Fix with Claude** button)
- **Precondition:** the planned PR is `open` and no agent run is active for the item.
- **Prompt input:** the worker fetches through the host GitHub client:
  - the PR's unresolved review threads (path, line, comments)
  - each failing check run's name and the last 200 lines of its log, if available
- **Instructions:**
  - Check out the branch and pull.
  - Address each thread and failing check.
  - Re-run validation.
  - Commit and push.
  - Reply on each thread you addressed with a one-line description of the change, then resolve it.
  - Leave threads you disagree with or cannot fix unresolved, with a reply explaining why.
- **Output:** `{ addressed: string[], notAddressed: [{ threadId: string, reason: string }], summary: string }`.
- **On success:** write activity; the next poll refreshes the counts. A failure sets `last_error` on the item and the planned PR; it doesn't change `work_state`.

## 5. Plan review and posting

**Actions** (core, transactional, refusing dismissed items):

| Action | Precondition | Effect |
|---|---|---|
| `startInvestigation` | `linear_issue_id` set, `work_state` = null, no active job | enqueue `prepare-workspace` (if no ready workspace) then `investigate`; `work_state` → `investigating` |
| `editPlan(content)` | `plan_ready` | validate (body non-empty, ≥1 breakdown row, repos in map); new version, author user |
| `revisePlan(feedback)` | `plan_ready`, feedback non-empty | `work_state` → `investigating`; enqueue `investigate { feedback }` |
| `approvePlan` | `plan_ready`, latest plan valid | generate comment UUID; `work_state` → `posting_plan`; enqueue `post-plan { commentUuid }` |
| `retryWork` | `work_state = failed` | restore `work_failed_from_state`; requeue the failed job |
| `fixPr(plannedPrId)` | item `implementing` or `prs_open`; PR `open`; no active agent job for item | enqueue `fix-pr` |
| `stopRun` | an agent run is active for the item | signal the worker to kill the exec (the worker checks a `stop_requested` flag on the job each second) |
| `removeWorkspace` | no active agent job | enqueue `remove-workspace` (the worker removes the container and volume; `workspaces.status = removed`) |

`jobs` gains a `stop_requested` integer column for `stopRun`.

**`post-plan` job** (core lane)
1. If `comment(id: commentUuid)` already exists, skip to step 3. Linear's `CommentCreateInput.id` accepts a client-supplied UUID v4 (verified in the published @linear/sdk 97.2.0 types).
2. Otherwise call `commentCreate({ id: commentUuid, issueId, body })`, where the body is `## Implementation plan\n\n<body>\n\n### PR breakdown\n1. \`repo\` — scope\n…`.
3. In one transaction:
   - record `plan_comment_id`;
   - create the `planned_prs` rows from the approved plan's breakdown (`github_repo` and `branch` derived from the map and the issue);
   - set `work_state` → `implementing` and `category` → `in_progress`;
   - enqueue `implement-pr` for position 1.
4. If `agent.linearStatusOnImplement` is set, move the Linear issue to that workflow state (looked up by name in the issue's team). This is idempotent: setting the same state twice is a no-op. A failure here only logs activity and sets `last_error`; it doesn't block implementation.

## 6. GitHub poller

A third poller next to Slack and Linear (`poll_cursors.source = 'github'`), running every `agent.prPollSeconds` (default 120).

- **Query:** one GraphQL query batch for all planned PRs in state `open` whose item is `implementing` or `prs_open`.
- **Collected fields:** `isDraft`, `merged`, `reviewThreads(first: 100) { isResolved }` (the unresolved count) and `commits(last: 1) { statusCheckRollup { state } }`, mapped to `ci_state`.
- **Writes:** the planned PR's status fields and `polled_at`.
- **Errors:** handled like the other pollers. They are recorded in `poll_cursors` and shown in the header.

## 7. Dashboard and CLI

### Cards

- In Progress and Verification cards show `opened/planned PRs`.
- They also show a CI dot: ✗ if any PR fails, … if any is pending, ✓ if all succeed, nothing if all are `none`.
- `💬 N` shows the total unresolved threads.

### Item sheet: new panels, shown when relevant

- **Work header:**
  - the work state badge
  - **Start investigation** (when allowed)
  - **Retry** for a failed work state
  - the workspace status with **Remove workspace**
- **Plan:**
  - Markdown body editor
  - breakdown editor: rows of repo select (from the map) plus scope text, reorderable, add/remove
  - version picker
  - **Revise with feedback**
  - **Approve plan** (enabled only when the plan is valid)
  - Read-only once approved, with a link to the Linear comment.
- **PRs:**
  - one row per planned PR: position, repo, scope, PR link, draft/merged, CI dot, `💬 N`, state, and last run outcome
  - **Fix with Claude** per open PR
- **Run:** while an agent run is active, a live tail of the last 30 assistant text and tool-call lines from the run log (served by a route that reads `data/runs/<id>.jsonl`), plus **Stop run**.

### CLI additions

- `queue investigate <id>`
- `queue plan <id> [--json]`
- `queue approve-plan <id>`
- `queue revise-plan <id> "<feedback>"`
- `queue fix-pr <id> <position>`
- `queue stop-run <id>`
- `queue workspace rm <id>`
- `queue show <id> --json` also includes the plan, planned PRs, workspace and runs.

## 8. Configuration

```yaml
agent:
  containerEngine: podman
  image: workflow-agent:latest
  maxConcurrent: 1
  timeoutMinutes: { investigate: 20, implement: 60 }
  maxTurns: { investigate: 60, implement: 200 }
  prPollSeconds: 120
  workspaceRetentionDays: 7
  meetingpackageSkillDir: ~/.claude/skills/meetingpackage
  dockerSkillDir: ~/.claude/skills/docker   # only for sync-env.sh
  syncEnv: true
  defaultRepos: []
  linearStatusOnImplement: null             # e.g. "In Progress"
rules:
  - when: { source: linear, label: ready-to-investigate }
    category: triage
    action: start-investigation             # new; allowed on linear rules only
```

- `triage-draft` stays Slack-only.
- `start-investigation` is Linear-only. It starts an investigation only if `work_state` is null and the item is not dismissed.

## 9. Testing

**Seams:**
- `ContainerEngine` (with `FakeEngine`)
- `AgentRunner` (builds args per kind, parses stream-json; tested with scripted lines from `FakeEngine`)
- `GitHubClient` (fetch-injected, with `FakeGitHub`)

**Unit (pure):**
- the work-state machine
- breakdown validation against the repo map
- the plan comment renderer
- the PR status rollup for cards
- the stream-json parser (final result and tail lines)
- engine argument building, asserting secrets are passed only as `--env NAME`

**Handlers (real SQLite plus fakes):**
- investigate: read-only tool flags; env without `GH_TOKEN`; a plan version saved; unknown repo → resume once → permanent failure
- post-plan: a lost response then retry posts one comment
- implement-pr: positions in order; PR verified before `open`; failure marks only that PR; retry with an existing open PR skips Claude; the last PR moves the item to verification
- fix-pr: the prompt contains threads and failing checks; failure keeps `work_state`
- timeout and Stop run: kill, then permanent failure, outcome recorded
- dismissal mid-implementation: no further PRs are started
- GitHub poller: status fields updated; errors recorded
- agent lane: a triage job completes while an implement job is running

**Opt-in integration:** `npm run test:podman` builds the image, creates a throwaway workspace, runs `claude --version` inside it, and removes it. Not part of `npm test`.

**Live:** `npm run smoke` adds GitHub `viewer` (host token), `podman info`, and `claude -p` "reply ok" inside a throwaway container with `CLAUDE_CODE_OAUTH_TOKEN`.

**UI:** the demo seed adds:
- a `plan_ready` item;
- an `implementing` item whose PRs mix CI states and unresolved threads;
- an item with a running agent run and a log file.

Playwright then checks the Plan editor, Approve plan, the PRs panel, Fix with Claude enqueueing, and Stop run.

## 10. Out of scope

- the Verification worker (sub-project 5)
- automatic fix rounds without a click
- merging or un-drafting PRs
- staging database tunnels and VPN
- agents on another machine
- changes to the `docker`, `github` or `meetingpackage` skills
- multi-user access
