import type { z } from 'zod';
import type { LinearIssueRef, ThreadMessage } from '../types';

export type SlackReactionItem = { channel: string; ts: string; threadTs: string; reactions: string[] };
export interface SlackClient {
  authTest(): Promise<{ userId: string; team: string }>;
  listMyReactions(cursor?: string): Promise<{ items: SlackReactionItem[]; nextCursor?: string }>;
  getThread(channel: string, threadTs: string): Promise<ThreadMessage[]>;
  getPermalink(channel: string, ts: string): Promise<string>;
}

export type LinearIssueState = LinearIssueRef & { status: string; labels: string[]; updatedAt: string };
export type LinearCandidate = LinearIssueRef & { status: string; description: string; closedAt: string | null };
export interface LinearClient {
  viewer(): Promise<{ id: string; name: string }>;
  listMyIssuesUpdatedSince(since: string | null, after?: string): Promise<{ issues: LinearIssueState[]; endCursor: string | null; hasNextPage: boolean }>;
  searchIssues(term: string, teamKey: string, first: number): Promise<LinearCandidate[]>;
  getTeamId(teamKey: string): Promise<string>;
  getIssue(idOrIdentifier: string): Promise<LinearIssueRef | null>;
  createIssue(input: { teamId: string; title: string; description: string }): Promise<LinearIssueRef>;
  attachUrl(issueId: string, url: string, title: string): Promise<void>;
  findIssueByAttachmentUrl(url: string): Promise<LinearIssueRef | null>;
  findMyRecentIssue(teamKey: string, title: string, description: string, sinceIso: string): Promise<LinearIssueRef | null>;
}

export type PromptName = 'search-terms' | 'assess-duplicates' | 'draft';
export interface ClaudeClient {
  run<T>(name: PromptName, vars: Record<string, string>, schema: z.ZodType<T>): Promise<T>;
}
