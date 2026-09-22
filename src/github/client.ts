import { type RepositoryReader, safeSourcePath } from '../context/repository.js';
import { type DiffInput, decodeDiff, MAX_DIFF_BYTES } from '../core/input.js';

const API_ROOT = 'https://api.github.com';
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_PAGES = 10;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export interface PullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  title?: string;
  body?: string | null;
  head: { sha: string };
  base: { sha: string; ref?: string };
}

export interface PullRequestReview {
  id: number;
  commit_id: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
}

export interface InlineComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface ExistingComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string };
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
  return (
    right.state === 'open' && left.head.sha === right.head.sha && left.base.sha === right.base.sha
  );
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async fetchApi(url: string, options: RequestInit): Promise<Response> {
    const signal = options.signal ?? AbortSignal.timeout(15_000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.fetchImpl(url, { ...options, signal, redirect: 'manual' });
      if (![301, 302, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('GitHub redirect has no destination');
      const target = new URL(location, url);
      if (target.origin !== API_ROOT || target.username || target.password)
        throw new Error('GitHub redirect left its API origin');
      url = target.href;
    }
    throw new Error('GitHub redirect limit exceeded');
  }

  private async bytes(
    path: string,
    options: RequestInit = {},
    limit = MAX_API_RESPONSE_BYTES,
  ): Promise<Buffer> {
    try {
      const response = await this.fetchApi(`${API_ROOT}${path}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'user-agent': 'pr-review-agent-flue',
          'x-github-api-version': '2022-11-28',
          ...options.headers,
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

  async request<T>(
    path: string,
    options: RequestInit = {},
    limit = MAX_API_RESPONSE_BYTES,
  ): Promise<T> {
    const bytes = await this.bytes(path, options, limit);
    if (!bytes.length) return undefined as T;
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } catch {
      throw new Error('GitHub returned an invalid JSON response');
    }
  }

  currentUser(): Promise<{ login: string }> {
    return this.request('/user');
  }

  async getPullRequest(repository: string, number: number): Promise<PullRequest> {
    const pr = await this.request<PullRequest>(`/repos/${repository}/pulls/${number}`);
    if (
      pr.number !== number ||
      !COMMIT_SHA.test(pr.head?.sha ?? '') ||
      !COMMIT_SHA.test(pr.base?.sha ?? '') ||
      !['open', 'closed'].includes(pr.state)
    )
      throw new Error('GitHub returned an invalid PR snapshot');
    if (pr.state === 'open') {
      // PR metadata can retain an older base SHA after the target branch advances.
      // Read the actual branch ref on every snapshot, including publication rechecks.
      if (typeof pr.base.ref !== 'string' || !pr.base.ref || pr.base.ref.length > 1024) {
        throw new Error('GitHub returned an invalid PR base reference');
      }
      const ref = await this.request<{ ref: string; object: { type: string; sha: string } }>(
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`,
      );
      if (
        ref.ref !== `refs/heads/${pr.base.ref}` ||
        ref.object?.type !== 'commit' ||
        !COMMIT_SHA.test(ref.object?.sha ?? '')
      ) {
        throw new Error('GitHub base branch identity could not be verified');
      }
      pr.base = { ...pr.base, sha: ref.object.sha };
    }
    return { ...pr, html_url: `https://github.com/${repository}/pull/${number}` };
  }

  async snapshotDiff(
    repository: string,
    pr: PullRequest,
  ): Promise<{ binding: ReviewBinding; diff: DiffInput }> {
    // The PR base tip is not necessarily its merge base. Resolve that from immutable commit IDs first.
    const compared = await this.request<{
      base_commit: { sha: string };
      merge_base_commit: { sha: string };
      files: unknown[];
    }>(`/repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`);
    if (
      compared.base_commit?.sha !== pr.base.sha ||
      !COMMIT_SHA.test(compared.merge_base_commit?.sha ?? '') ||
      !Array.isArray(compared.files) ||
      compared.files.length >= 300
    ) {
      throw new Error('GitHub comparison identity or file coverage could not be verified');
    }
    const mergeBase = compared.merge_base_commit.sha;
    const diff = decodeDiff(
      await this.bytes(
        `/repos/${repository}/compare/${mergeBase}...${pr.head.sha}`,
        { headers: { accept: 'application/vnd.github.v3.diff' } },
        MAX_DIFF_BYTES,
      ),
    );
    return {
      binding: { base: pr.base.sha, merge_base: mergeBase, head: pr.head.sha, diff: diff.sha256 },
      diff,
    };
  }

  async listReviews(repository: string, number: number): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const batch = await this.request<PullRequestReview[]>(
        `/repos/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid review list');
      reviews.push(...batch);
      if (batch.length < 100) return reviews;
    }
    throw new Error('review history exceeds the reconciliation budget');
  }

  publishReview(
    repository: string,
    number: number,
    head: string,
    body: string,
    comments: readonly InlineComment[] = [],
  ): Promise<PullRequestReview> {
    if (Buffer.byteLength(body) > 60 * 1024)
      throw new Error('review is too large to publish safely');
    return this.request(`/repos/${repository}/pulls/${number}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'COMMENT',
        commit_id: head,
        body,
        ...(comments.length ? { comments } : {}),
      }),
    });
  }

  async listComments(repository: string, number: number): Promise<ExistingComment[]> {
    const comments: ExistingComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<ExistingComment[]>(
        `/repos/${repository}/pulls/${number}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error('invalid GitHub comment response');
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
    throw new Error('comment history exceeds the reconciliation budget');
  }

  async canReview(repository: string, login: string): Promise<boolean> {
    if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login)) return false;
    const permission = await this.request<{ permission: string }>(
      `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ['admin', 'maintain', 'write'].includes(permission.permission);
  }

  async readFile(repository: string, path: string, revision: string): Promise<string | undefined> {
    if (!safeSourcePath(path) || !COMMIT_SHA.test(revision))
      throw new Error('invalid source identity');
    const response = await this.fetchApi(
      `${API_ROOT}/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'user-agent': 'pr-review-agent',
        },
      },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('repository source could not be read');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 64 * 1024) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(next.value);
      }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      type: string;
      size: number;
      encoding: string;
      content: string;
      submodule_git_url?: string;
    };
    if (
      value.type !== 'file' ||
      value.submodule_git_url ||
      value.size > 32 * 1024 ||
      value.encoding !== 'base64'
    )
      return undefined;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.content, 'base64'));
    } catch {
      return undefined;
    }
  }

  repositoryReader(repository: string, revision: string): RepositoryReader {
    return {
      revision,
      read: (path) => this.readFile(repository, path, revision),
      paths: async () => {
        const commit = await this.request<{ tree: { sha: string } }>(
          `/repos/${repository}/git/commits/${revision}`,
        );
        if (!COMMIT_SHA.test(commit.tree?.sha ?? '')) throw new Error('invalid repository tree');
        const tree = await this.request<{
          truncated: boolean;
          tree: Array<{ path: string; mode: string; type: string }>;
        }>(`/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`, {}, 16 * 1024 * 1024);
        if (tree.truncated || !Array.isArray(tree.tree))
          throw new Error('repository tree exceeds context coverage limits');
        return tree.tree
          .filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode))
          .map((entry) => entry.path);
      },
    };
  }

  async latestStatus(repository: string, head: string): Promise<CommitStatus | undefined> {
    const response = await this.request<{ statuses: CommitStatus[] }>(
      `/repos/${repository}/commits/${head}/status`,
    );
    if (!Array.isArray(response.statuses))
      throw new Error('GitHub returned an invalid status list');
    return response.statuses.find((status) => status.context === 'PR review agent');
  }

  async setStatus(
    repository: string,
    head: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string,
    targetUrl: string,
  ): Promise<void> {
    await this.request(`/repos/${repository}/statuses/${head}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: 'PR review agent',
        target_url: targetUrl,
      }),
    });
  }
}
