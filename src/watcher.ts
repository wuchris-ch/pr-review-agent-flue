#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { DiffInput } from './input.js';
import { GitHubClient, sameRevision, type PullRequest, type PullRequestReview, type ReviewBinding } from './github.js';
import { formatGitHubReview } from './pr.js';
import { reviewDiff } from './runner.js';
import type { Review } from './schema.js';

const REVIEW_POLICY_VERSION = '2';

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
  return `<!-- pr-review-agent head:${headSha} policy:${REVIEW_POLICY_VERSION} -->`;
}

function bindingMarker(binding: ReviewBinding, state: 'success' | 'failure'): string {
  return `<!-- pr-review-agent binding:${JSON.stringify({ version: 1, base: binding.base, merge_base: binding.merge_base, head: binding.head, diff: binding.diff, state })} -->`;
}

export function formatAutomatedReview(review: Review, headSha: string, binding?: ReviewBinding): string {
  if (binding && (binding.head !== headSha || binding.diff !== review.input_sha256)) throw new Error('review does not match its source binding');
  return `${formatGitHubReview(review)}\n${marker(headSha)}\n${binding ? bindingMarker(binding, review.blocked ? 'failure' : 'success') + '\n' : ''}`;
}

interface Receipt { review: PullRequestReview; state: 'success' | 'failure' }

type WatcherClient = Pick<GitHubClient, 'getPullRequest' | 'snapshotDiff' | 'listReviews' | 'publishReview' | 'latestStatus' | 'setStatus'>;

function matchingReceipt(reviews: PullRequestReview[], binding: ReviewBinding, login: string): Receipt | undefined {
  for (const review of reviews) {
    if (review.user?.login !== login || review.commit_id !== binding.head || review.state !== 'COMMENTED'
      || !Number.isSafeInteger(review.id) || review.id <= 0) continue;
    for (const state of ['success', 'failure'] as const) {
      if (review.body?.split('\n').includes(bindingMarker(binding, state))) return { review, state };
    }
  }
  return undefined;
}

function receiptForRevision(reviews: PullRequestReview[], snapshot: PullRequest, login: string): Receipt | undefined {
  // Immutable base/head IDs imply the same comparison. Reuse its verified receipt without downloading the diff again.
  for (const review of [...reviews].reverse()) {
    for (const line of review.body?.split('\n') ?? []) {
      const match = /^<!-- pr-review-agent binding:(\{.*\}) -->$/.exec(line);
      if (!match) continue;
      try {
        const binding = JSON.parse(match[1]!) as ReviewBinding & { version: number; state: string };
        if (binding.version !== 1 || binding.base !== snapshot.base.sha || binding.head !== snapshot.head.sha
          || !/^[a-f0-9]{40}$/.test(binding.merge_base) || !/^[a-f0-9]{64}$/.test(binding.diff)) continue;
        const receipt = matchingReceipt([review], { base: binding.base, merge_base: binding.merge_base, head: binding.head, diff: binding.diff }, login);
        if (receipt) return receipt;
      } catch { /* A comment is untrusted data; malformed markers are not receipts. */ }
    }
  }
  return undefined;
}

/** Receipt-based reconciliation covers a lost POST response and a restart before status publication. */
async function settleReceipt(client: WatcherClient, repository: string, snapshot: PullRequest, receipt: Receipt): Promise<boolean> {
  const unchanged = (): Promise<boolean> => client.getPullRequest(repository, snapshot.number).then((current) => sameRevision(snapshot, current));
  if (!await unchanged()) return false;
  const url = `https://github.com/${repository}/pull/${snapshot.number}#pullrequestreview-${receipt.review.id}`;
  const status = await client.latestStatus(repository, snapshot.head.sha);
  if (status?.state !== receipt.state || status.target_url !== url) {
    await client.setStatus(repository, snapshot.head.sha, receipt.state,
      receipt.state === 'failure' ? 'Automated review found blocking issues' : 'Automated review found no blocking issues', url);
  }
  // The create-review/status APIs have no atomic compare-and-swap on a PR's base/head pair.
  // Reconcile changes observed during publication without ever assigning this result to a new head.
  return unchanged();
}

export async function reviewPullRequest(
  client: WatcherClient,
  repository: string,
  listed: Pick<PullRequest, 'number'>,
  login: string,
  reviewer: (diff: DiffInput) => Review | Promise<Review> = reviewDiff,
): Promise<'reviewed' | 'reconciled' | 'changed' | 'closed' | 'failed'> {
  const label = `${repository}#${listed.number}`;
  let snapshot: PullRequest | undefined;
  let ownsStatus = false;
  const changed = async (): Promise<'changed'> => {
    if (snapshot && ownsStatus) await client.setStatus(repository, snapshot.head.sha, 'error', 'PR base or head changed; review deferred to the next poll', snapshot.html_url);
    return 'changed';
  };
  try {
    // Never use the potentially stale head from the polling list as the analysis identity.
    snapshot = await client.getPullRequest(repository, listed.number);
    if (snapshot.state !== 'open') return 'closed';
    const existing = receiptForRevision(await client.listReviews(repository, listed.number), snapshot, login);
    if (existing) {
      ownsStatus = true;
      return await settleReceipt(client, repository, snapshot, existing) ? 'reconciled' : await changed();
    }
    const { binding, diff } = await client.snapshotDiff(repository, snapshot);
    if (!sameRevision(snapshot, await client.getPullRequest(repository, listed.number))) return await changed();
    let receipt = matchingReceipt(await client.listReviews(repository, listed.number), binding, login);
    if (receipt) {
      ownsStatus = true;
      return await settleReceipt(client, repository, snapshot, receipt) ? 'reconciled' : await changed();
    }
    console.log(`reviewing ${label} at ${binding.head.slice(0, 12)}`);
    ownsStatus = true;
    await client.setStatus(repository, binding.head, 'pending', 'Automated review is running', snapshot.html_url);
    const review = await reviewer(diff);
    const body = formatAutomatedReview(review, binding.head, binding);
    if (!sameRevision(snapshot, await client.getPullRequest(repository, listed.number))) return await changed();
    // Reconcile once more before POST, including a prior ambiguous publication.
    receipt = matchingReceipt(await client.listReviews(repository, listed.number), binding, login);
    if (!receipt) {
      try {
        const published = await client.publishReview(repository, listed.number, binding.head, body);
        receipt = matchingReceipt([published], binding, login);
      } catch {
        // Do not blindly repeat a POST: GitHub may have committed it before the connection failed.
      }
      receipt ??= matchingReceipt(await client.listReviews(repository, listed.number), binding, login);
      if (!receipt) throw new Error('GitHub review publication is unconfirmed; the next poll will reconcile it');
    }
    if (!await settleReceipt(client, repository, snapshot, receipt)) return await changed();
    console.log(`completed ${label} at ${binding.head.slice(0, 12)}`);
    return 'reviewed';
  } catch {
    console.error(`review failed for ${label}; will reconcile on the next poll`);
    if (snapshot && ownsStatus) {
      await client.setStatus(repository, snapshot.head.sha, 'error', 'Automated review could not complete and will retry', snapshot.html_url)
        .catch(() => console.error(`could not publish failure status for ${label}`));
    }
    return 'failed';
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
