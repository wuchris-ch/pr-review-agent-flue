import { ghSource, publishGitHubReview } from '../../sources/gh-cli.js';
import type { Command } from '../harness.js';
import { EXIT_OK } from '../harness.js';
import { reviewFromSource } from '../review-run.js';

const USAGE = 'usage: pr-review-pr <number-or-url> [--repo <owner/repo>] [--publish]';
const PR_NUMBER = /^[1-9][0-9]*$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PullRequestArgs {
  pullRequest: string;
  repository?: string;
  publish: boolean;
}

export function parsePullRequestArgs(args: readonly string[]): PullRequestArgs {
  let pullRequest: string | undefined;
  let repository: string | undefined;
  let publish = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--publish') {
      if (publish) {
        throw new Error(USAGE);
      }
      publish = true;
      continue;
    }
    if (argument === '--repo') {
      const value = args[index + 1];
      if (!value || repository !== undefined || !REPOSITORY.test(value)) {
        throw new Error(USAGE);
      }
      repository = value;
      index += 1;
      continue;
    }
    if (argument === undefined || pullRequest !== undefined) {
      throw new Error(USAGE);
    }
    pullRequest = argument;
  }

  if (pullRequest === undefined || !(PR_NUMBER.test(pullRequest) || PR_URL.test(pullRequest))) {
    throw new Error(USAGE);
  }

  return { pullRequest, publish, ...(repository === undefined ? {} : { repository }) };
}

export const prCommand: Command = {
  name: 'pr',
  summary: 'Review one GitHub pull request, optionally publishing the result.',
  usage: USAGE,
  async run(args, { io, cwd }) {
    const options = parsePullRequestArgs(args);
    const review = await reviewFromSource(
      ghSource({
        cwd,
        pullRequest: options.pullRequest,
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        // Only trust local guidance when reviewing the checkout's own repository.
        useLocalInstructions: options.repository === undefined,
      }),
    );
    io.stdout(`${JSON.stringify(review, null, 2)}\n`);

    if (options.publish) {
      publishGitHubReview(options, review, cwd);
      io.stderr('GitHub review comment published.\n');
    }
    return EXIT_OK;
  },
};
