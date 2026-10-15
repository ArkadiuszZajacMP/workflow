import { errorMessage, PermanentError, TransientError } from '../errors';
import type { LinearIssueRef } from '../types';
import type { LinearCandidate, LinearClient, LinearIssueDetails, LinearIssueState } from './types';

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_REF = 'id identifier title url';

const MY_ISSUES = `query MyIssues($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_REF} updatedAt state { name } labels { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SEARCH = `query Search($term: String!, $filter: IssueFilter, $first: Int) {
  searchIssues(term: $term, filter: $filter, first: $first) {
    nodes { ${ISSUE_REF} description completedAt canceledAt state { name } }
  }
}`;

const TEAM = `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`;
const ISSUE = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_REF} } }`;
const VIEWER = `query Viewer { viewer { id name } }`;
const CREATE = `mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_REF} } }
}`;
const ATTACH = `mutation Attach($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`;
const ISSUE_DETAILS = `query IssueDetails($id: String!) { issue(id: $id) { ${ISSUE_REF} description comments(first: 20) { nodes { body } } } }`;
const COMMENT = `query Comment($id: String!) { comment(id: $id) { id } }`;
const CREATE_COMMENT = `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;
const ISSUE_STATES = `query IssueStates($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`;
const UPDATE_ISSUE = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const FOR_URL = `query ForUrl($url: String!) { attachmentsForURL(url: $url) { nodes { issue { ${ISSUE_REF} } } } }`;

type GqlError = { message: string; extensions?: { code?: string } };

export const LINEAR_TIMEOUT_MS = 30_000;

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function retryAfterMs(res: Response): number | undefined {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

export function createLinearClient(apiKey: string, fetchImpl: typeof fetch = fetch): LinearClient {
  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      });
    } catch (err) {
      if (isTimeout(err)) throw new TransientError(`Linear request timed out after ${LINEAR_TIMEOUT_MS / 1000}s`);
      throw new TransientError(`Linear request failed: ${errorMessage(err)}`);
    }
    if (res.status === 429) throw new TransientError('Linear rate limited', retryAfterMs(res));
    if (res.status >= 500) throw new TransientError(`Linear server error ${res.status}`);

    const body = (await res.json().catch((err: unknown) => {
      if (isTimeout(err)) throw new TransientError(`Linear request timed out after ${LINEAR_TIMEOUT_MS / 1000}s`);
      return {};
    })) as { data?: T; errors?: GqlError[] };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join('; ');
      if (body.errors.some((e) => e.extensions?.code === 'RATELIMITED')) {
        throw new TransientError(`Linear rate limited: ${message}`, 60_000);
      }
      throw new PermanentError(`Linear API error: ${message}`);
    }
    if (!res.ok || !body.data) throw new PermanentError(`Linear request failed with status ${res.status}`);
    return body.data;
  }

  return {
    async viewer() {
      return (await gql<{ viewer: { id: string; name: string } }>(VIEWER)).viewer;
    },

    async listMyIssuesUpdatedSince(since, after) {
      const mine = { or: [{ assignee: { isMe: { eq: true } } }, { creator: { isMe: { eq: true } } }] };
      const filter = since
        ? { ...mine, updatedAt: { gte: since } }
        : { ...mine, state: { type: { nin: ['completed', 'canceled'] } } };
      const data = await gql<{
        issues: {
          nodes: (LinearIssueRef & { updatedAt: string; state: { name: string }; labels: { nodes: { name: string }[] } })[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(MY_ISSUES, { filter, after });
      const issues: LinearIssueState[] = data.issues.nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        updatedAt: n.updatedAt,
        status: n.state.name,
        labels: n.labels.nodes.map((l) => l.name),
      }));
      return { issues, endCursor: data.issues.pageInfo.endCursor, hasNextPage: data.issues.pageInfo.hasNextPage };
    },

    async searchIssues(term, teamKey, first) {
      const data = await gql<{
        searchIssues: {
          nodes: (LinearIssueRef & {
            description: string | null;
            completedAt: string | null;
            canceledAt: string | null;
            state: { name: string };
          })[];
        };
      }>(SEARCH, { term, first, filter: { team: { key: { eq: teamKey } } } });
      return data.searchIssues.nodes.map(
        (n): LinearCandidate => ({
          id: n.id,
          identifier: n.identifier,
          title: n.title,
          url: n.url,
          description: n.description ?? '',
          status: n.state.name,
          closedAt: n.completedAt ?? n.canceledAt ?? null,
        }),
      );
    },

    async getTeamId(teamKey) {
      const data = await gql<{ teams: { nodes: { id: string }[] } }>(TEAM, { key: teamKey });
      const team = data.teams.nodes[0];
      if (!team) throw new PermanentError(`Linear team "${teamKey}" not found`);
      return team.id;
    },

    async getIssue(idOrIdentifier) {
      try {
        return (await gql<{ issue: LinearIssueRef | null }>(ISSUE, { id: idOrIdentifier })).issue;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return null;
        throw err;
      }
    },

    async createIssue(input) {
      const data = await gql<{ issueCreate: { success: boolean; issue: LinearIssueRef | null } }>(CREATE, { input });
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new PermanentError('Linear did not create the issue');
      return data.issueCreate.issue;
    },

    async attachUrl(issueId, url, title) {
      const data = await gql<{ attachmentLinkURL: { success: boolean } }>(ATTACH, { issueId, url, title });
      if (!data.attachmentLinkURL.success) throw new PermanentError('Linear did not attach the URL');
    },

    async getIssueDetails(idOrIdentifier) {
      try {
        const data = await gql<{
          issue: (LinearIssueRef & { description: string | null; comments: { nodes: { body: string }[] } }) | null;
        }>(ISSUE_DETAILS, { id: idOrIdentifier });
        const issue = data.issue;
        if (!issue) return null;
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          description: issue.description ?? '',
          comments: issue.comments.nodes.map((c) => c.body),
        } satisfies LinearIssueDetails;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return null;
        throw err;
      }
    },

    async commentExists(id) {
      try {
        return (await gql<{ comment: { id: string } | null }>(COMMENT, { id })).comment !== null;
      } catch (err) {
        if (err instanceof PermanentError && /not found/i.test(err.message)) return false;
        throw err;
      }
    },

    async createComment(input) {
      const data = await gql<{ commentCreate: { success: boolean } }>(CREATE_COMMENT, { input });
      if (!data.commentCreate.success) throw new PermanentError('Linear did not create the comment');
    },

    async setIssueStateByName(issueId, stateName) {
      const data = await gql<{ issue: { team: { states: { nodes: { id: string; name: string }[] } } } | null }>(ISSUE_STATES, { id: issueId });
      const state = data.issue?.team.states.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
      if (!state) throw new PermanentError(`Linear state "${stateName}" not found`);
      const updated = await gql<{ issueUpdate: { success: boolean } }>(UPDATE_ISSUE, { id: issueId, input: { stateId: state.id } });
      if (!updated.issueUpdate.success) throw new PermanentError('Linear did not update the issue state');
    },

    async findIssueByAttachmentUrl(url) {
      const data = await gql<{ attachmentsForURL: { nodes: { issue: LinearIssueRef }[] } }>(FOR_URL, { url });
      return data.attachmentsForURL.nodes[0]?.issue ?? null;
    },
  };
}
