import { setTimeout as sleep } from 'node:timers/promises';
import { mapConcurrent } from '../core/concurrency.js';
import type { DiffInput } from '../core/input.js';
import type { Review } from '../core/schema.js';
import { formatGitHubReview } from '../render/github.js';
import {
  GitHubClient,
  type PullRequest,
  type PullRequestReview,
  type ReviewBinding,
  sameRevision,
} from '../sources/github-api.js';
import { reviewAndRecord } from '../telemetry/recorded-review.js';

const REVIEW_POLICY_VERSION = '2';
const BINDING_MARKER = /^<!-- pr-review-agent binding:(\{.*\}) -->$/;

export interface WatcherConfig {
  token: string;
  repositories: string[];
  intervalMs: number;
  concurrency: number;
}

export type WatchOutcome = 'reviewed' | 'reconciled' | 'changed' | 'closed' | 'failed';

type WatcherClient = Pick<
  GitHubClient,
  'getPullRequest' | 'snapshotDiff' | 'listReviews' | 'publishReview' | 'latestStatus' | 'setStatus'
>;

interface Receipt {
  review: PullRequestReview;
  state: 'success' | 'failure';
}

function requiredEnvironment(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function parseRepositories(value: string): string[] {
  const repositories = [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (
    repositories.length === 0 ||
    repositories.some((repository) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  ) {
    throw new Error('GITHUB_REPOSITORIES must contain owner/repository names');
  }
  return repositories;
}

export function watcherConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const intervalSeconds = Number.parseInt(env.REVIEW_POLL_INTERVAL_SECONDS ?? '60', 10);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 15) {
    throw new Error('REVIEW_POLL_INTERVAL_SECONDS must be at least 15');
  }
  const concurrency = Number.parseInt(env.REVIEW_WATCH_CONCURRENCY ?? '2', 10);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('REVIEW_WATCH_CONCURRENCY must be an integer between 1 and 8');
  }
  return {
    token: requiredEnvironment('GITHUB_TOKEN', env),
    repositories: parseRepositories(requiredEnvironment('GITHUB_REPOSITORIES', env)),
    intervalMs: intervalSeconds * 1000,
    concurrency,
  };
}

function marker(headSha: string): string {
  return `<!-- pr-review-agent head:${headSha} policy:${REVIEW_POLICY_VERSION} -->`;
}

function bindingMarker(binding: ReviewBinding, state: 'success' | 'failure'): string {
  return `<!-- pr-review-agent binding:${JSON.stringify({
    version: 1,
    base: binding.base,
    merge_base: binding.merge_base,
    head: binding.head,
    diff: binding.diff,
    state,
  })} -->`;
}

export function formatAutomatedReview(
  review: Review,
  headSha: string,
  binding?: ReviewBinding,
): string {
  if (binding && (binding.head !== headSha || binding.diff !== review.input_sha256)) {
    throw new Error('review does not match its source binding');
  }
  const state = review.blocked ? 'failure' : 'success';
  const receipt = binding ? `${bindingMarker(binding, state)}\n` : '';
  return `${formatGitHubReview(review)}\n${marker(headSha)}\n${receipt}`;
}

function matchingReceipt(
  reviews: readonly PullRequestReview[],
  binding: ReviewBinding,
  login: string,
): Receipt | undefined {
  for (const review of reviews) {
    if (
      review.user?.login !== login ||
      review.commit_id !== binding.head ||
      review.state !== 'COMMENTED' ||
      !Number.isSafeInteger(review.id) ||
      review.id <= 0
    ) {
      continue;
    }
    for (const state of ['success', 'failure'] as const) {
      if (review.body?.split('\n').includes(bindingMarker(binding, state))) {
        return { review, state };
      }
    }
  }
  return undefined;
}

function receiptForRevision(
  reviews: readonly PullRequestReview[],
  snapshot: PullRequest,
  login: string,
): Receipt | undefined {
  // Immutable base/head IDs imply the same comparison. Reuse a verified
  // receipt instead of downloading and re-reviewing the same diff.
  for (const review of [...reviews].reverse()) {
    for (const line of review.body?.split('\n') ?? []) {
      const match = BINDING_MARKER.exec(line);
      if (!match) {
        continue;
      }
      try {
        const binding = JSON.parse(match[1] as string) as ReviewBinding & { version: number };
        if (
          binding.version !== 1 ||
          binding.base !== snapshot.base.sha ||
          binding.head !== snapshot.head.sha ||
          !/^[a-f0-9]{40}$/.test(binding.merge_base) ||
          !/^[a-f0-9]{64}$/.test(binding.diff)
        ) {
          continue;
        }
        const receipt = matchingReceipt([review], binding, login);
        if (receipt) {
          return receipt;
        }
      } catch {
        // A comment is untrusted data; a malformed marker is not a receipt.
      }
    }
  }
  return undefined;
}

/** Receipt reconciliation covers a lost POST response and a restart mid-publication. */
async function settleReceipt(
  client: WatcherClient,
  repository: string,
  snapshot: PullRequest,
  receipt: Receipt,
): Promise<boolean> {
  const unchanged = (): Promise<boolean> =>
    client
      .getPullRequest(repository, snapshot.number)
      .then((current) => sameRevision(snapshot, current));

  if (!(await unchanged())) {
    return false;
  }

  const url = `https://github.com/${repository}/pull/${String(snapshot.number)}#pullrequestreview-${String(receipt.review.id)}`;
  const status = await client.latestStatus(repository, snapshot.head.sha);
  if (status?.state !== receipt.state || status.target_url !== url) {
    await client.setStatus(
      repository,
      snapshot.head.sha,
      receipt.state,
      receipt.state === 'failure'
        ? 'Automated review found blocking issues'
        : 'Automated review found no blocking issues',
      url,
    );
  }
  // The create-review and status APIs offer no compare-and-swap on a PR's
  // base/head pair. Re-check rather than ever binding this result to a new head.
  return unchanged();
}

/**
 * Revisions this process already reconciled, keyed by repository, number,
 * base, and head.
 *
 * GitHub comments remain the durable source of truth; this only avoids
 * re-listing an unchanged PR's full review history on every poll. A restart
 * clears it and reconciliation runs again from the receipts.
 */
export class SettledRevisions {
  private readonly seen = new Set<string>();

  private static key(repository: string, pr: PullRequest): string {
    return `${repository}#${String(pr.number)}@${pr.base.sha}:${pr.head.sha}`;
  }

  has(repository: string, pr: PullRequest): boolean {
    return this.seen.has(SettledRevisions.key(repository, pr));
  }

  add(repository: string, pr: PullRequest): void {
    this.seen.add(SettledRevisions.key(repository, pr));
  }
}

export async function reviewPullRequest(
  client: WatcherClient,
  repository: string,
  listed: Pick<PullRequest, 'number'>,
  login: string,
  reviewer: (diff: DiffInput) => Review | Promise<Review> = (diff) =>
    reviewAndRecord(diff, { label: `${repository}#${String(listed.number)}`, source: 'watch' }),
  settled?: SettledRevisions,
): Promise<WatchOutcome> {
  const label = `${repository}#${String(listed.number)}`;
  let snapshot: PullRequest | undefined;
  let ownsStatus = false;

  const changed = async (): Promise<'changed'> => {
    if (snapshot && ownsStatus) {
      await client.setStatus(
        repository,
        snapshot.head.sha,
        'error',
        'PR base or head changed; review deferred to the next poll',
        snapshot.html_url,
      );
    }
    return 'changed';
  };

  try {
    // Never treat the polling list's head as the analysis identity; it can be stale.
    snapshot = await client.getPullRequest(repository, listed.number);
    if (snapshot.state !== 'open') {
      return 'closed';
    }
    if (settled?.has(repository, snapshot)) {
      return 'reconciled';
    }

    const existing = receiptForRevision(
      await client.listReviews(repository, listed.number),
      snapshot,
      login,
    );
    if (existing) {
      ownsStatus = true;
      if (!(await settleReceipt(client, repository, snapshot, existing))) {
        return await changed();
      }
      settled?.add(repository, snapshot);
      return 'reconciled';
    }

    const { binding, diff } = await client.snapshotDiff(repository, snapshot);
    if (!sameRevision(snapshot, await client.getPullRequest(repository, listed.number))) {
      return await changed();
    }

    let receipt = matchingReceipt(
      await client.listReviews(repository, listed.number),
      binding,
      login,
    );
    if (receipt) {
      ownsStatus = true;
      if (!(await settleReceipt(client, repository, snapshot, receipt))) {
        return await changed();
      }
      settled?.add(repository, snapshot);
      return 'reconciled';
    }

    console.log(`reviewing ${label} at ${binding.head.slice(0, 12)}`);
    ownsStatus = true;
    await client.setStatus(
      repository,
      binding.head,
      'pending',
      'Automated review is running',
      snapshot.html_url,
    );

    const review = await reviewer(diff);
    const body = formatAutomatedReview(review, binding.head, binding);
    if (!sameRevision(snapshot, await client.getPullRequest(repository, listed.number))) {
      return await changed();
    }

    // Reconcile once more before POST, covering a prior ambiguous publication.
    receipt = matchingReceipt(await client.listReviews(repository, listed.number), binding, login);
    if (!receipt) {
      try {
        const published = await client.publishReview(repository, listed.number, binding.head, body);
        receipt = matchingReceipt([published], binding, login);
      } catch {
        // Never blindly repeat the POST: GitHub may have committed it
        // before the connection failed.
      }
      receipt ??= matchingReceipt(
        await client.listReviews(repository, listed.number),
        binding,
        login,
      );
      if (!receipt) {
        throw new Error(
          'GitHub review publication is unconfirmed; the next poll will reconcile it',
        );
      }
    }

    if (!(await settleReceipt(client, repository, snapshot, receipt))) {
      return await changed();
    }
    settled?.add(repository, snapshot);
    console.log(`completed ${label} at ${binding.head.slice(0, 12)}`);
    return 'reviewed';
  } catch {
    console.error(`review failed for ${label}; will reconcile on the next poll`);
    if (snapshot && ownsStatus) {
      await client
        .setStatus(
          repository,
          snapshot.head.sha,
          'error',
          'Automated review could not complete and will retry',
          snapshot.html_url,
        )
        .catch(() => console.error(`could not publish failure status for ${label}`));
    }
    return 'failed';
  }
}

async function poll(
  client: GitHubClient,
  config: WatcherConfig,
  login: string,
  settled: SettledRevisions,
): Promise<void> {
  for (const repository of config.repositories) {
    let pullRequests: PullRequest[];
    try {
      pullRequests = await client.listPullRequests(repository);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`could not list ${repository}: ${message}`);
      continue;
    }
    await mapConcurrent(pullRequests, config.concurrency, (pullRequest) =>
      reviewPullRequest(client, repository, pullRequest, login, undefined, settled),
    );
  }
}

export async function runWatcher(config: WatcherConfig = watcherConfig()): Promise<never> {
  const client = new GitHubClient(config.token);
  const { login } = await client.currentUser();
  const settled = new SettledRevisions();
  console.log(
    `watching ${config.repositories.join(', ')} every ${String(config.intervalMs / 1000)} seconds as ${login}, ${String(config.concurrency)} at a time`,
  );
  for (;;) {
    await poll(client, config, login, settled);
    await sleep(config.intervalMs);
  }
}
