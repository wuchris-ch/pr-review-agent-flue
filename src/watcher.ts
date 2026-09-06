#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { decodeDiff } from './input.js';
import { formatGitHubReview } from './pr.js';
import { reviewDiff } from './runner.js';
import type { Review } from './schema.js';

const API_ROOT = 'https://api.github.com';
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'pr-review-agent-flue';
const REVIEW_POLICY_VERSION = '2';

interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string };
}

interface PullRequestReview {
  body: string | null;
  user: { login: string } | null;
}

interface GitHubUser {
  login: string;
}

interface WatcherConfig {
  token: string;
  repositories: string[];
  intervalMs: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function parseRepositories(value: string): string[] {
  const repositories = [...new Set(
    value.split(',').map((item) => item.trim()).filter(Boolean),
  )];
  if (
    repositories.length === 0
    || repositories.some(
      (repository) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    )
  ) {
    throw new Error('GITHUB_REPOSITORIES must contain owner/repository names');
  }
  return repositories;
}

function configuration(): WatcherConfig {
  const intervalSeconds = Number.parseInt(
    process.env.REVIEW_POLL_INTERVAL_SECONDS ?? '60',
    10,
  );
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 15) {
    throw new Error('REVIEW_POLL_INTERVAL_SECONDS must be at least 15');
  }
  return {
    token: requiredEnvironment('GITHUB_TOKEN'),
    repositories: parseRepositories(requiredEnvironment('GITHUB_REPOSITORIES')),
    intervalMs: intervalSeconds * 1000,
  };
}

function marker(headSha: string): string {
  return `<!-- pr-review-agent-flue head:${headSha} policy:${REVIEW_POLICY_VERSION} -->`;
}

export function formatAutomatedReview(review: Review, headSha: string): string {
  return `${formatGitHubReview(review)}\n${marker(headSha)}\n`;
}

class GitHubClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
        ...options.headers,
      },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_API_RESPONSE_BYTES) {
      throw new Error('GitHub response exceeded the safe byte limit');
    }
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${String(response.status)}`);
    }
    if (!bytes.length) {
      return undefined as T;
    }
    return JSON.parse(bytes.toString('utf8')) as T;
  }

  currentUser(): Promise<GitHubUser> {
    return this.request('/user');
  }

  listPullRequests(repository: string): Promise<PullRequest[]> {
    return this.request(`/repos/${repository}/pulls?state=open&per_page=100`);
  }

  async pullRequestDiff(repository: string, number: number): Promise<Buffer> {
    const response = await fetch(
      `${API_ROOT}/repos/${repository}/pulls/${String(number)}`,
      {
        headers: {
          accept: 'application/vnd.github.v3.diff',
          authorization: `Bearer ${this.token}`,
          'user-agent': USER_AGENT,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(`GitHub diff request returned HTTP ${String(response.status)}`);
    }
    if (!bytes.length || bytes.length > MAX_API_RESPONSE_BYTES) {
      throw new Error('pull request diff is empty or exceeds the safe byte limit');
    }
    return bytes;
  }

  listReviews(
    repository: string,
    number: number,
  ): Promise<PullRequestReview[]> {
    return this.request(
      `/repos/${repository}/pulls/${String(number)}/reviews?per_page=100`,
    );
  }

  publishReview(repository: string, number: number, body: string): Promise<void> {
    return this.request(
      `/repos/${repository}/pulls/${String(number)}/reviews`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'COMMENT', body }),
      },
    );
  }

  setStatus(
    repository: string,
    headSha: string,
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string,
    targetUrl: string,
  ): Promise<void> {
    return this.request(`/repos/${repository}/statuses/${headSha}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: 'PR review agent (Flue)',
        target_url: targetUrl,
      }),
    });
  }
}

async function alreadyReviewed(
  client: GitHubClient,
  repository: string,
  pullRequest: PullRequest,
  login: string,
): Promise<boolean> {
  const expected = marker(pullRequest.head.sha);
  const reviews = await client.listReviews(repository, pullRequest.number);
  return reviews.some(
    (review) => review.user?.login === login && review.body?.includes(expected),
  );
}

async function reviewPullRequest(
  client: GitHubClient,
  repository: string,
  pullRequest: PullRequest,
  login: string,
): Promise<void> {
  if (await alreadyReviewed(client, repository, pullRequest, login)) {
    return;
  }

  const label = `${repository}#${String(pullRequest.number)}`;
  console.log(`reviewing ${label} at ${pullRequest.head.sha.slice(0, 12)}`);
  try {
    await client.setStatus(
      repository,
      pullRequest.head.sha,
      'pending',
      'Automated review is running',
      pullRequest.html_url,
    );
    const diff = decodeDiff(await client.pullRequestDiff(
      repository,
      pullRequest.number,
    ));
    const review = reviewDiff(diff);
    await client.setStatus(
      repository,
      pullRequest.head.sha,
      review.blocked ? 'failure' : 'success',
      review.blocked
        ? 'Automated review found blocking issues'
        : 'Automated review found no blocking issues',
      pullRequest.html_url,
    );
    await client.publishReview(
      repository,
      pullRequest.number,
      formatAutomatedReview(review, pullRequest.head.sha),
    );
    console.log(`completed ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`review failed for ${label}: ${message}`);
    try {
      await client.setStatus(
        repository,
        pullRequest.head.sha,
        'error',
        'Automated review could not complete and will retry',
        pullRequest.html_url,
      );
    } catch {
      console.error(`could not publish failure status for ${label}`);
    }
  }
}

async function poll(
  client: GitHubClient,
  repositories: readonly string[],
  login: string,
): Promise<void> {
  for (const repository of repositories) {
    let pullRequests: PullRequest[];
    try {
      pullRequests = await client.listPullRequests(repository);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`could not list ${repository}: ${message}`);
      continue;
    }
    for (const pullRequest of pullRequests) {
      await reviewPullRequest(client, repository, pullRequest, login);
    }
  }
}

async function main(): Promise<void> {
  const config = configuration();
  const client = new GitHubClient(config.token);
  const { login } = await client.currentUser();
  console.log(
    `watching ${config.repositories.join(', ')} every ${String(config.intervalMs / 1000)} seconds as ${login}`,
  );
  for (;;) {
    await poll(client, config.repositories, login);
    await sleep(config.intervalMs);
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`watcher failed: ${message}\n`);
    process.exitCode = 1;
  });
}
