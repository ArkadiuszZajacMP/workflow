import { describe, expect, it } from 'vitest';
import type { Rule } from '@/core/config/schema';
import { type LinearLabelEvent, type LinearStatusEvent, linearEventKey, type SlackReactionEvent, slackEventKey } from '@/core/events';
import { matchRule } from './match';

const issue = { id: 'i1', identifier: 'ENG-1', title: 'Broken', url: 'https://linear.app/x/ENG-1' };
const eyes: SlackReactionEvent = { source: 'slack', kind: 'reaction_added', reaction: 'eyes', channel: 'C1', ts: '2.0', threadTs: '1.0' };
const triageStatus: LinearStatusEvent = { source: 'linear', kind: 'status_changed', issue, status: 'Triage' };
const label: LinearLabelEvent = { source: 'linear', kind: 'label_added', issue, label: 'needs-investigation' };

const rules: Rule[] = [
  { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
  { when: { source: 'slack', reaction: 'eyes' }, category: 'done' },
  { when: { source: 'slack', reaction: 'bookmark' }, category: 'triage' },
  { when: { source: 'linear', status: 'triage' }, category: 'triage' },
  { when: { source: 'linear', label: 'Needs-Investigation' }, category: 'in_progress' },
];

describe('matchRule', () => {
  it('returns the first matching rule with its action', () => {
    expect(matchRule(eyes, rules)).toEqual({ category: 'triage', action: 'triage-draft' });
  });

  it('omits action when the rule has none', () => {
    expect(matchRule({ ...eyes, reaction: 'bookmark' }, rules)).toEqual({ category: 'triage' });
  });

  it('matches Linear status and label names case-insensitively', () => {
    expect(matchRule(triageStatus, rules)).toEqual({ category: 'triage' });
    expect(matchRule(label, rules)).toEqual({ category: 'in_progress' });
  });

  it('does not let a status rule match a label event of the same name', () => {
    expect(matchRule({ ...label, label: 'Triage' }, rules)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchRule({ ...eyes, reaction: 'thumbsup' }, rules)).toBeNull();
    expect(matchRule(eyes, [])).toBeNull();
  });
});

describe('event keys', () => {
  it('builds stable keys', () => {
    expect(slackEventKey('C1', '2.0', 'eyes')).toBe('slack:C1:2.0:eyes');
    expect(linearEventKey(triageStatus, '2026-10-10T10:00:00.000Z')).toBe('linear:i1:status:Triage:2026-10-10T10:00:00.000Z');
    expect(linearEventKey(label, 't')).toBe('linear:i1:label:needs-investigation:t');
  });
});
