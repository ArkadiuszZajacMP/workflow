import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderPrompt } from '@/core/clients/claude';

export type AgentPromptName = 'agent-investigate' | 'agent-implement' | 'agent-fix';

export function renderAgentPrompt(promptsDir: string, name: AgentPromptName, vars: Record<string, string>): string {
  return renderPrompt(readFileSync(path.join(promptsDir, `${name}.md`), 'utf8'), vars);
}
