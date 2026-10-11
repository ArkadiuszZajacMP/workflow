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
