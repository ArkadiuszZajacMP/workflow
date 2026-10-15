# workflow

A personal task queue fed by Slack reactions and Linear changes, with a Claude-assisted 👀 triage flow and a local dashboard.

## Setup

1. `npm install`
2. Secrets are read from 1Password at start-up (`scripts/with-secrets.sh` resolves each `op://` reference with `op read`), so nothing is stored on disk. This also works with the Windows `op.exe` from WSL. Install the 1Password CLI, sign in (`op signin`, or turn on CLI integration in the desktop app), then `cp .env.op.example .env.op` and point the two references at your Slack user token (`xoxp-…`) and Linear API key. `.env.op` is gitignored and holds only `op://` references. If you have several 1Password accounts, set `OP_ACCOUNT` (for example `export OP_ACCOUNT=meetingpackage.1password.com`).
3. Set `linear.defaultTeam` in `workflow.config.yaml`.
4. `npm run smoke` checks the Slack, Linear and Claude credentials. The worker and `smoke` load secrets this way; the dashboard and the `queue` CLI need none.

## Run

- `npm run dev` starts the dashboard on http://127.0.0.1:3000 and the worker (pollers + jobs).
- `npm run queue -- list` / `show <id>` / `approve <id>` / `link <id> ENG-123` / `revise <id> "feedback"` / `move <id> <category>` / `discard <id>` / `retry <id>`. Add `--json` to `list` and `show` for machine-readable output.

On its first run the Slack poller records your existing reactions without queueing them. Only reactions added afterwards trigger rules. Set `slack.backfillOnFirstRun: true` to change this.

## Config

`workflow.config.yaml` maps events to categories. The first matching rule wins. The worker re-reads the file every poll cycle. If an edit makes it invalid, the worker keeps the last valid version and the header shows `config: error`.

## Agent workers (investigation and implementation)

Agent workers run Claude Code inside a per-issue Podman container (`wf-<issue>`), so code changes never touch your machine.

1. Install Podman (rootless) and build the image: `npm run agent:build-image`.
2. Create a long-lived Claude Code token with `claude setup-token` and store it in 1Password.
3. Add `GITHUB_TOKEN`, `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` references to `.env.op` (see `.env.op.example`). The GitHub token needs repo access to the repositories you work on. Prefer a fine-grained token limited to those repositories, without workflow or admin permissions: the agent runs unattended with this token.
4. Make sure `~/.claude/skills/meetingpackage` (repo map) and `~/.claude/skills/github` exist. For repos that install from AWS CodeArtifact, run `aws sso login --profile <profile>` when prompted.
5. `npm run smoke` checks GitHub, Podman and Claude inside the container.

Flow:
- On an item with a Linear issue, click **Start investigation** (or `npm run queue -- investigate <id>`, or a rule with `action: start-investigation`).
- Review the plan and its PR breakdown, edit or revise it, then **Approve plan**. The plan is posted as a Linear comment and implementation starts.
- One draft PR is opened per breakdown row, in order. When all are open, the item moves to Verification.
- PR cards and the sheet show CI and unresolved review threads. **Fix with Claude** runs one fix round for a PR.
- **Stop run** kills the current run (also after the item is dismissed; dismissing an item asks its running agent to stop). **Retry work** resumes a failed step (`npm run queue -- retry <id>` does the same for failed work). Workspaces are removed `agent.workspaceRetentionDays` (default 7) days after an item is done or dismissed, or with **Remove workspace**.
- `npm run dev` restarts the worker whenever its source changes, which stops in-flight agent runs and requeues them. Don't edit code under this worktree while agents are running. Ctrl-C stops the worker the same way: runs are stopped and requeued (press Ctrl-C twice to exit without waiting).

## Tests

`npm test` (no network). `npm run typecheck`.

## Design

- Spec: `docs/superpowers/specs/2026-10-10-queue-triage-design.md`
- Plan: `docs/superpowers/plans/2026-10-10-queue-triage.md`
