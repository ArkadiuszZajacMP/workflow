# Claude skills for this repo

## Plugins (enabled in `.claude/settings.json`)

| Plugin | Marketplace | Purpose |
|---|---|---|
| superpowers | claude-plugins-official | Brainstorm → plan → execute, test-first development, systematic debugging, verification |
| typescript-lsp | claude-plugins-official | Type and go-to-definition information (needs global `typescript-language-server`) |
| frontend-design | claude-plugins-official | Dashboard UI quality |
| skill-creator | claude-plugins-official | Author and test project-specific skills |
| example-skills | anthropic-agent-skills (`anthropics/skills`) | `webapp-testing` (Playwright checks of the running app) and others |

New machine: trust the repo when Claude Code prompts, then accept the plugin install prompt. Also run
`npm i -g typescript typescript-language-server`.

## Vendored skills (folders in this directory)

Installed with `npx skills add <repo> --skill <name> --agent claude-code --copy`. Sources and hashes are pinned in `/skills-lock.json`.

- `vercel-react-best-practices`, `vercel-composition-patterns`: from `vercel-labs/agent-skills`
- `shadcn`: from `shadcn/ui`. It pre-approves `npx shadcn@latest *` commands.

To update: `npx skills update -p`, then review the diff before committing.

## Adding skills

- Read `SKILL.md` and any scripts before installing. Skills run with full agent permissions.
- Prefer `anthropics/`, `obra/` and official vendor sources.
- Put project-specific skills, such as task-queue conventions, in this directory. Use `skill-creator` to write them.
