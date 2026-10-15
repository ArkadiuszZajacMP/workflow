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

## Tests

`npm test` (no network). `npm run typecheck`.

## Design

- Spec: `docs/superpowers/specs/2026-10-10-queue-triage-design.md`
- Plan: `docs/superpowers/plans/2026-10-10-queue-triage.md`
