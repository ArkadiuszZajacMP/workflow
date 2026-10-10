import type { LinearIssueRef } from './types';

export type SlackReactionEvent = {
  source: 'slack';
  kind: 'reaction_added';
  reaction: string;
  channel: string;
  ts: string;
  threadTs: string;
};

export type LinearStatusEvent = { source: 'linear'; kind: 'status_changed'; issue: LinearIssueRef; status: string };

export type LinearLabelEvent = { source: 'linear'; kind: 'label_added'; issue: LinearIssueRef; label: string };

export type SourceEvent = SlackReactionEvent | LinearStatusEvent | LinearLabelEvent;

export function slackEventKey(channel: string, ts: string, reaction: string): string {
  return `slack:${channel}:${ts}:${reaction}`;
}

export function linearEventKey(event: LinearStatusEvent | LinearLabelEvent, updatedAt: string): string {
  return event.kind === 'status_changed'
    ? `linear:${event.issue.id}:status:${event.status}:${updatedAt}`
    : `linear:${event.issue.id}:label:${event.label}:${updatedAt}`;
}
