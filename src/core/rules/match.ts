import type { Rule, RuleCategory } from '../config/schema';
import type { SourceEvent } from '../events';

export type RuleMatch = { category: RuleCategory; action?: 'triage-draft' };

export function matchRule(event: SourceEvent, rules: Rule[]): RuleMatch | null {
  for (const rule of rules) {
    if (!whenMatches(rule.when, event)) continue;
    return rule.action ? { category: rule.category, action: rule.action } : { category: rule.category };
  }
  return null;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function whenMatches(when: Rule['when'], event: SourceEvent): boolean {
  if ('reaction' in when) return event.kind === 'reaction_added' && event.reaction === when.reaction;
  if ('status' in when) return event.kind === 'status_changed' && sameName(event.status, when.status);
  return event.kind === 'label_added' && sameName(event.label, when.label);
}
