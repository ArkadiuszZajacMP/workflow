import { homedir } from 'node:os';
import path from 'node:path';

/** Expands a leading `~` (as in `~/.claude/skills/...` config values) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}
