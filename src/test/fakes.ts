import type { z } from 'zod';
import type {
  ClaudeClient,
  LinearCandidate,
  LinearClient,
  LinearIssueState,
  PromptName,
  SlackClient,
  SlackReactionItem,
} from '@/core/clients/types';
import { type Config, configSchema } from '@/core/config/schema';
import { PermanentError, TransientError } from '@/core/errors';
import type { LinearIssueRef, ThreadMessage } from '@/core/types';

export const TEST_CONFIG: Config = configSchema.parse({
  linear: { defaultTeam: 'ENG' },
  rules: [
    { when: { source: 'slack', reaction: 'eyes' }, category: 'triage', action: 'triage-draft' },
    { when: { source: 'slack', reaction: 'bookmark' }, category: 'triage' },
    { when: { source: 'linear', status: 'Triage' }, category: 'triage' },
    { when: { source: 'linear', label: 'needs-investigation' }, category: 'triage' },
  ],
});

export class FakeSlack implements SlackClient {
  pages: { items: SlackReactionItem[]; nextCursor?: string }[] = [];
  listCalls: (string | undefined)[] = [];
  threads = new Map<string, ThreadMessage[]>();

  setPages(...pages: SlackReactionItem[][]): void {
    this.pages = pages.map((items, i) => ({ items, nextCursor: i < pages.length - 1 ? String(i + 1) : undefined }));
  }

  async authTest() {
    return { userId: 'U_ME', team: 'Test' };
  }

  async listMyReactions(cursor?: string) {
    this.listCalls.push(cursor);
    return this.pages[cursor ? Number(cursor) : 0] ?? { items: [] };
  }

  async getThread(channel: string, threadTs: string) {
    const thread = this.threads.get(`${channel}:${threadTs}`);
    if (!thread) throw new PermanentError('Slack API error: thread_not_found');
    return thread;
  }

  async getPermalink(channel: string, ts: string) {
    return `https://slack.test/archives/${channel}/p${ts.replace('.', '')}`;
  }
}

export class FakeLinear implements LinearClient {
  issuePages: { issues: LinearIssueState[]; endCursor: string | null; hasNextPage: boolean }[] = [];
  sinceCalls: (string | null)[] = [];
  searchResults = new Map<string, LinearCandidate[]>();
  issues = new Map<string, LinearIssueRef>();
  attachmentsByUrl = new Map<string, LinearIssueRef>();
  created: { teamId: string; title: string; description: string }[] = [];
  createdIssues: (LinearIssueRef & { description: string })[] = [];
  loseNextCreateResponse = false;
  attached: { issueId: string; url: string; title: string }[] = [];
  failures: Partial<Record<keyof LinearClient, Error>> = {};
  private nextNumber = 100;

  private maybeFail(method: keyof LinearClient): void {
    const err = this.failures[method];
    if (err) {
      delete this.failures[method];
      throw err;
    }
  }

  setIssuePages(...pages: LinearIssueState[][]): void {
    this.issuePages = pages.map((issues, i) => ({
      issues,
      endCursor: i < pages.length - 1 ? String(i + 1) : null,
      hasNextPage: i < pages.length - 1,
    }));
  }

  addIssue(ref: LinearIssueRef): void {
    this.issues.set(ref.id, ref);
    this.issues.set(ref.identifier, ref);
  }

  async viewer() {
    return { id: 'me', name: 'Me' };
  }

  async listMyIssuesUpdatedSince(since: string | null, after?: string) {
    this.maybeFail('listMyIssuesUpdatedSince');
    this.sinceCalls.push(since);
    return this.issuePages[after ? Number(after) : 0] ?? { issues: [], endCursor: null, hasNextPage: false };
  }

  async searchIssues(term: string) {
    this.maybeFail('searchIssues');
    return this.searchResults.get(term) ?? [];
  }

  async getTeamId(teamKey: string) {
    this.maybeFail('getTeamId');
    return `team-${teamKey}`;
  }

  async getIssue(idOrIdentifier: string) {
    this.maybeFail('getIssue');
    return this.issues.get(idOrIdentifier) ?? null;
  }

  async createIssue(input: { teamId: string; title: string; description: string }) {
    this.maybeFail('createIssue');
    this.created.push(input);
    const n = this.nextNumber++;
    const ref = { id: `issue-${n}`, identifier: `ENG-${n}`, title: input.title, url: `https://linear.test/ENG-${n}` };
    this.addIssue(ref);
    this.createdIssues.push({ ...ref, description: input.description });
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new TransientError('timeout');
    }
    return ref;
  }

  async findMyRecentIssue(_teamKey: string, title: string, description: string, _sinceIso: string) {
    this.maybeFail('findMyRecentIssue');
    const hit = this.createdIssues.find((i) => i.title === title && i.description.trim() === description.trim());
    return hit ? { id: hit.id, identifier: hit.identifier, title: hit.title, url: hit.url } : null;
  }

  async attachUrl(issueId: string, url: string, title: string) {
    this.maybeFail('attachUrl');
    this.attached.push({ issueId, url, title });
    const ref = this.issues.get(issueId);
    if (ref) this.attachmentsByUrl.set(url, ref);
  }

  async findIssueByAttachmentUrl(url: string) {
    this.maybeFail('findIssueByAttachmentUrl');
    return this.attachmentsByUrl.get(url) ?? null;
  }
}

export class FakeClaude implements ClaudeClient {
  private responses: Partial<Record<PromptName, unknown[]>> = {};
  calls: { name: PromptName; vars: Record<string, string> }[] = [];

  respond(name: PromptName, ...values: unknown[]): this {
    (this.responses[name] ??= []).push(...values);
    return this;
  }

  async run<T>(name: PromptName, vars: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ name, vars });
    const next = this.responses[name]?.shift();
    if (next === undefined) throw new Error(`FakeClaude: no response queued for ${name}`);
    if (next instanceof Error) throw next;
    return schema.parse(next);
  }
}
