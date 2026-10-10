import type { LinearCandidate } from '../clients/types';
import type { DraftContent } from '../drafts';
import type { ThreadMessage } from '../types';

export function formatThread(messages: ThreadMessage[]): string {
  return messages
    .map((m) => `[${m.userName}] ${m.text}${m.files.length ? ` (files: ${m.files.join(', ')})` : ''}`)
    .join('\n\n');
}

export function formatCandidates(candidates: LinearCandidate[]): string {
  return candidates
    .map((c) => `${c.identifier} [${c.status}] ${c.title}\n${c.description.slice(0, 500)}`)
    .join('\n---\n');
}

export function formatDraft(draft: DraftContent | undefined): string {
  if (!draft) return '(none)';
  const criteria = draft.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
  return `Title: ${draft.title}\n\nProblem:\n${draft.problem}\n\nAcceptance criteria:\n${criteria}`;
}

export function titleFromText(text: string, max = 120): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return '(no text)';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
