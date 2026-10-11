# workflow

A personal tool that organizes tasks into a queue and sorts them into categories. A web dashboard shows the queue's status.

## Planned stack
- Next.js (App Router) + TypeScript
- shadcn/ui + Tailwind CSS
- SQLite (better-sqlite3, optionally with Drizzle ORM), stored in a single local DB file
- A small CLI to change the queue, so Claude skills can drive it too

Sub-projects 1–3 (queue core, ingestion, 👀 triage) are implemented; see README.md for commands. Next: investigation/implementation workers (sub-project 4).

## Claude setup
Project plugins and skills are listed in `.claude/skills/README.md`. Use superpowers' brainstorming and writing-plans skills for new features. Use webapp-testing to check UI changes against the running app.
