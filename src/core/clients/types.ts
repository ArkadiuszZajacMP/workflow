import type { CiState } from '../db/schema';
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
export type LinearIssueDetails = LinearIssueRef & { description: string; comments: string[] };
export type LinearCandidate = LinearIssueRef & { status: string; description: string; closedAt: string | null };
export interface LinearClient {
  viewer(): Promise<{ id: string; name: string }>;
  listMyIssuesUpdatedSince(since: string | null, after?: string): Promise<{ issues: LinearIssueState[]; endCursor: string | null; hasNextPage: boolean }>;
  searchIssues(term: string, teamKey: string, first: number): Promise<LinearCandidate[]>;
  getTeamId(teamKey: string): Promise<string>;
  getIssue(idOrIdentifier: string): Promise<LinearIssueRef | null>;
  getIssueDetails(idOrIdentifier: string): Promise<LinearIssueDetails | null>;
  commentExists(id: string): Promise<boolean>;
  /** `id` is a client-generated UUID v4 that Linear uses as the comment id. */
  createComment(input: { id: string; issueId: string; body: string }): Promise<void>;
  setIssueStateByName(issueId: string, stateName: string): Promise<void>;
  /** `id` is a client-generated UUID v4 that Linear uses as the issue id. */
  createIssue(input: { id: string; teamId: string; title: string; description: string }): Promise<LinearIssueRef>;
  attachUrl(issueId: string, url: string, title: string): Promise<void>;
  findIssueByAttachmentUrl(url: string): Promise<LinearIssueRef | null>;
}

export type PromptName = 'search-terms' | 'assess-duplicates' | 'draft';
export interface ClaudeClient {
  run<T>(name: PromptName, vars: Record<string, string>, schema: z.ZodType<T>): Promise<T>;
}

export type PrRef = { repo: string; number: number };
export type PullRequestInfo = {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  merged: boolean;
  headRefName: string;
  headSha: string;
};
export type PrStatus = { isDraft: boolean; merged: boolean; state: string; unresolvedThreads: number; ciState: CiState };
export type ReviewThread = { id: string; path: string | null; line: number | null; comments: { author: string; body: string }[] };
export type FailingCheck = { name: string; summary: string; logTail: string };

export interface GitHubClient {
  viewer(): Promise<{ login: string }>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo | null>;
  findOpenPrForBranch(repo: string, branch: string): Promise<PullRequestInfo | null>;
  /** Keyed by `prKey(repo, number)`. PRs that GitHub does not return are missing from the map. */
  prStatuses(prs: PrRef[]): Promise<Map<string, PrStatus>>;
  unresolvedThreads(repo: string, number: number): Promise<ReviewThread[]>;
  failingChecks(repo: string, number: number): Promise<FailingCheck[]>;
}
