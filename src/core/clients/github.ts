import type { CiState } from '../db/schema';
import { errorMessage, PermanentError, TransientError } from '../errors';
import type { FailingCheck, GitHubClient, PrStatus, PullRequestInfo, ReviewThread } from './types';

const API = 'https://api.github.com';
export const GITHUB_TIMEOUT_MS = 30_000;
const STATUS_BATCH = 20;
const PR_FIELDS = 'number url state isDraft merged headRefName headRefOid';

export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function mapCiState(state: string | null | undefined): CiState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new PermanentError(`Invalid GitHub repository "${repo}"`);
  return { owner, name };
}

type PrNode = { number: number; url: string; state: string; isDraft: boolean; merged: boolean; headRefName: string; headRefOid: string };

function toInfo(n: PrNode): PullRequestInfo {
  return {
    number: n.number,
    url: n.url,
    state: n.state as PullRequestInfo['state'],
    isDraft: n.isDraft,
    merged: n.merged,
    headRefName: n.headRefName,
    headSha: n.headRefOid,
  };
}

export function createGitHubClient(token: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'workflow', ...init.headers },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new TransientError(`GitHub request timed out after ${GITHUB_TIMEOUT_MS / 1000}s`);
      throw new TransientError(`GitHub request failed: ${errorMessage(err)}`);
    }
    const retryAfterHeader = res.headers.get('retry-after');
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || retryAfterHeader !== null));
    if (rateLimited) {
      const retryAfterSec = Number(retryAfterHeader);
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let delay = 60_000;
      if (retryAfterHeader !== null && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) delay = retryAfterSec * 1000;
      else if (Number.isFinite(reset) && reset > 0) delay = Math.max(0, reset * 1000 - Date.now());
      throw new TransientError('GitHub rate limited', Math.min(delay, 15 * 60_000));
    }
    if (res.status >= 500) throw new TransientError(`GitHub server error ${res.status}`);
    if (res.status === 401) throw new PermanentError('GitHub authentication failed (check GITHUB_TOKEN)');
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new PermanentError(`GitHub request failed with status ${res.status}: ${body.message ?? res.statusText}`);
    }
    return res;
  }

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await request(`${API}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string; type?: string }[] };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join('; ');
      if (body.errors.some((e) => e.type === 'RATE_LIMITED')) throw new TransientError(`GitHub rate limited: ${message}`, 60_000);
      // A missing PR or repo comes back as NOT_FOUND with the rest of the data still present.
      if (body.data && body.errors.every((e) => e.type === 'NOT_FOUND')) return body.data;
      throw new PermanentError(`GitHub API error: ${message}`);
    }
    if (!body.data) throw new PermanentError('GitHub returned no data');
    return body.data;
  }

  async function getPullRequest(repo: string, number: number): Promise<PullRequestInfo | null> {
    const { owner, name } = splitRepo(repo);
    const data = await gql<{ repository: { pullRequest: PrNode | null } | null }>(
      `query Pr($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
      { owner, name, number },
    );
    const node = data.repository?.pullRequest;
    return node ? toInfo(node) : null;
  }

  return {
    async viewer() {
      return (await gql<{ viewer: { login: string } }>('query { viewer { login } }')).viewer;
    },

    getPullRequest,

    async findOpenPrForBranch(repo, branch) {
      const { owner, name } = splitRepo(repo);
      const data = await gql<{ repository: { pullRequests: { nodes: PrNode[] } } | null }>(
        `query Branch($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, states: OPEN, first: 1) { nodes { ${PR_FIELDS} } } } }`,
        { owner, name, branch },
      );
      const node = data.repository?.pullRequests.nodes[0];
      return node ? toInfo(node) : null;
    },

    async prStatuses(prs) {
      const result = new Map<string, PrStatus>();
      for (let start = 0; start < prs.length; start += STATUS_BATCH) {
        const batch = prs.slice(start, start + STATUS_BATCH);
        const fields = batch
          .map((pr, i) => {
            const { owner, name } = splitRepo(pr.repo);
            return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(pr.number)}) { isDraft merged state reviewThreads(first: 100) { nodes { isResolved } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
          })
          .join('\n');
        type Node = {
          pullRequest: {
            isDraft: boolean;
            merged: boolean;
            state: string;
            reviewThreads: { nodes: { isResolved: boolean }[] };
            commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
          } | null;
        } | null;
        const data = await gql<Record<string, Node>>(`query Statuses {\n${fields}\n}`);
        batch.forEach((pr, i) => {
          const node = data[`p${i}`]?.pullRequest;
          if (!node) return;
          result.set(prKey(pr.repo, pr.number), {
            isDraft: node.isDraft,
            merged: node.merged,
            state: node.state,
            unresolvedThreads: node.reviewThreads.nodes.filter((t) => !t.isResolved).length,
            ciState: mapCiState(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
          });
        });
      }
      return result;
    },

    async unresolvedThreads(repo, number) {
      const { owner, name } = splitRepo(repo);
      type ThreadNode = {
        id: string;
        isResolved: boolean;
        path: string | null;
        line: number | null;
        comments: { nodes: { author: { login: string } | null; body: string }[] };
      };
      const data = await gql<{ repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[] } } | null } | null }>(
        `query Threads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 20) { nodes { author { login } body } } } } } } }`,
        { owner, name, number },
      );
      return (data.repository?.pullRequest?.reviewThreads.nodes ?? [])
        .filter((t) => !t.isResolved)
        .map(
          (t): ReviewThread => ({
            id: t.id,
            path: t.path,
            line: t.line,
            comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body })),
          }),
        );
    },

    async failingChecks(repo, number) {
      const pr = await getPullRequest(repo, number);
      if (!pr) throw new PermanentError(`PR ${repo}#${number} not found`);
      const res = await request(`${API}/repos/${repo}/commits/${pr.headSha}/check-runs?per_page=100`);
      const body = (await res.json()) as {
        check_runs: { id: number; name: string; conclusion: string | null; app?: { slug?: string }; output?: { title?: string | null; summary?: string | null } }[];
      };
      const failing = body.check_runs.filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'action_required');
      const checks: FailingCheck[] = [];
      for (const run of failing) {
        let logTail = '';
        if (run.app?.slug === 'github-actions') {
          try {
            const log = await (await request(`${API}/repos/${repo}/actions/jobs/${run.id}/logs`)).text();
            logTail = log.replace(/\n$/, '').split('\n').slice(-200).join('\n');
          } catch (err) {
            // Only expired or missing logs are expected here; transient failures must reach the caller.
            if (err instanceof TransientError) throw err;
            logTail = '';
          }
        }
        const summary = [run.output?.title, run.output?.summary].filter(Boolean).join(' — ');
        checks.push({ name: run.name, summary, logTail });
      }
      return checks;
    },
  };
}
