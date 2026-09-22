import { createHash } from 'node:crypto';
import { retrieveContext } from '../context/repository.js';
import { parseRepositoryConfig } from '../core/repository-config.js';
import type { Review } from '../core/schema.js';
import { reviewAndRecord } from '../telemetry/recorded-review.js';
import { GitHubClient, sameRevision } from './client.js';
import { inlineComments } from './inline.js';
import { reviewPullRequest } from './review.js';

export interface GitHubRunOptions {
  repository: string;
  number: number;
  token: string;
  actor: string;
  publish: boolean;
  automatic?: boolean;
  expectedHead?: string;
  client?: GitHubClient;
}

/** Shared one-shot path for CLI, Actions and App webhooks. */
export async function runGitHubReview(
  options: GitHubRunOptions,
): Promise<{ outcome: string; review?: Review; blocked?: boolean; failOnFindings: boolean }> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
    !Number.isSafeInteger(options.number) ||
    options.number < 1
  )
    throw new Error('invalid GitHub pull request');
  const client = options.client ?? new GitHubClient(options.token);
  const snapshot = await client.getPullRequest(options.repository, options.number);
  if (options.expectedHead && options.expectedHead !== snapshot.head.sha)
    return { outcome: 'changed', failOnFindings: false };
  const config = parseRepositoryConfig(
    await client.readFile(options.repository, '.pr-review.json', snapshot.base.sha),
  );
  if (options.automatic && !config.autoReview)
    return { outcome: 'disabled', failOnFindings: false };
  const instructions = [
    await client.readFile(options.repository, 'AGENTS.md', snapshot.base.sha),
    ...config.rules,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 12000);
  const policy = createHash('sha256')
    .update(JSON.stringify({ config, instructions, version: 3 }))
    .digest('hex');
  let review: Review | undefined;
  const outcome = await reviewPullRequest(
    client,
    options.repository,
    { number: options.number },
    options.actor,
    async (diff) => {
      if (!sameRevision(snapshot, await client.getPullRequest(options.repository, options.number)))
        throw new Error('PR revision changed before context retrieval');
      const repositoryContext = config.context
        ? await retrieveContext(
            diff.text,
            client.repositoryReader(options.repository, snapshot.head.sha),
            config,
          )
        : undefined;
      review = await reviewAndRecord(
        diff,
        { label: `${options.repository}#${options.number}`, source: 'github' },
        {
          instructions,
          repositoryConfig: config,
          ...(repositoryContext ? { repositoryContext } : {}),
        },
      );
      return review;
    },
    undefined,
    {
      publish: options.publish,
      advisory: !config.failOnFindings,
      policy,
      inline: async (result, diff) =>
        inlineComments(
          result,
          diff.text,
          await client.listComments(options.repository, options.number),
          options.actor,
          config,
        ),
    },
  );
  const blocked =
    review?.blocked ??
    (outcome === 'reconciled' &&
      config.failOnFindings &&
      (await client.latestStatus(options.repository, snapshot.head.sha))?.state === 'failure');
  return { outcome, blocked, ...(review ? { review } : {}), failOnFindings: config.failOnFindings };
}
