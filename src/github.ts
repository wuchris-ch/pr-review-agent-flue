import { decodeDiff, MAX_DIFF_BYTES, type DiffInput } from './input.js';

const API_ROOT = 'https://api.github.com';
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_PAGES = 10;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export interface PullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  head: { sha: string };
  base: { sha: string };
}

export interface PullRequestReview {
  id: number;
  commit_id: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
}

export interface ReviewBinding {
  base: string;
  merge_base: string;
  head: string;
  diff: string;
}

export interface CommitStatus {
  context: string;
  state: string;
  target_url: string | null;
}

export function sameRevision(left: PullRequest, right: PullRequest): boolean {
  return right.state === 'open' && left.head.sha === right.head.sha && left.base.sha === right.base.sha;
}

export class GitHubClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async bytes(path: string, options: RequestInit = {}, limit = MAX_API_RESPONSE_BYTES): Promise<Buffer> {
    try {
      const response = await this.fetchImpl(`${API_ROOT}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`,
          'user-agent': 'pr-review-agent-flue', 'x-github-api-version': '2022-11-28', ...options.headers,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitHub API returned HTTP ${response.status}`);
      }
      if (!response.body) return Buffer.alloc(0);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Error('GitHub response exceeded the safe byte limit');
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    } catch {
      // Network errors may contain URLs or headers. Surface only a stable operator error.
      throw new Error('GitHub request failed or exceeded its response/time budget');
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const bytes = await this.bytes(path, options);
    try { return JSON.parse(bytes.toString('utf8')) as T; }
    catch { throw new Error('GitHub returned an invalid JSON response'); }
  }

  currentUser(): Promise<{ login: string }> { return this.request('/user'); }

  listPullRequests(repository: string): Promise<PullRequest[]> {
    return this.request(`/repos/${repository}/pulls?state=open&per_page=100`);
  }

  async getPullRequest(repository: string, number: number): Promise<PullRequest> {
    const pr = await this.request<PullRequest>(`/repos/${repository}/pulls/${number}`);
    if (pr.number !== number || !COMMIT_SHA.test(pr.head?.sha ?? '') || !COMMIT_SHA.test(pr.base?.sha ?? '')
      || !['open', 'closed'].includes(pr.state)) throw new Error('GitHub returned an invalid PR snapshot');
    return { ...pr, html_url: `https://github.com/${repository}/pull/${number}` };
  }

  async snapshotDiff(repository: string, pr: PullRequest): Promise<{ binding: ReviewBinding; diff: DiffInput }> {
    // The PR base tip is not necessarily its merge base. Resolve that from immutable commit IDs first.
    const compared = await this.request<{ base_commit: { sha: string }; merge_base_commit: { sha: string }; files: unknown[] }>(
      `/repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
    );
    if (compared.base_commit?.sha !== pr.base.sha || !COMMIT_SHA.test(compared.merge_base_commit?.sha ?? '')
      || !Array.isArray(compared.files) || compared.files.length >= 300) {
      throw new Error('GitHub comparison identity or file coverage could not be verified');
    }
    const mergeBase = compared.merge_base_commit.sha;
    const diff = decodeDiff(await this.bytes(
      `/repos/${repository}/compare/${mergeBase}...${pr.head.sha}`,
      { headers: { accept: 'application/vnd.github.v3.diff' } }, MAX_DIFF_BYTES,
    ));
    return { binding: { base: pr.base.sha, merge_base: mergeBase, head: pr.head.sha, diff: diff.sha256 }, diff };
  }

  async listReviews(repository: string, number: number): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const batch = await this.request<PullRequestReview[]>(`/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid review list');
      reviews.push(...batch);
      if (batch.length < 100) return reviews;
    }
    throw new Error('review history exceeds the reconciliation budget');
  }

  publishReview(repository: string, number: number, head: string, body: string): Promise<PullRequestReview> {
    if (Buffer.byteLength(body) > 60 * 1024) throw new Error('review is too large to publish safely');
    return this.request(`/repos/${repository}/pulls/${number}/reviews`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'COMMENT', commit_id: head, body }),
    });
  }

  async latestStatus(repository: string, head: string): Promise<CommitStatus | undefined> {
    const response = await this.request<{ statuses: CommitStatus[] }>(`/repos/${repository}/commits/${head}/status`);
    if (!Array.isArray(response.statuses)) throw new Error('GitHub returned an invalid status list');
    return response.statuses.find((status) => status.context === 'PR review agent');
  }

  async setStatus(repository: string, head: string, state: 'error' | 'failure' | 'pending' | 'success', description: string, targetUrl: string): Promise<void> {
    await this.request(`/repos/${repository}/statuses/${head}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, description: description.slice(0, 140), context: 'PR review agent', target_url: targetUrl }),
    });
  }
}
