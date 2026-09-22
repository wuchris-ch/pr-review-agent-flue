import { spawnSync } from 'node:child_process';
import { GitHubClient } from '../../github/client.js';
import { runGitHubReview } from '../../github/run.js';
import type { Command } from '../harness.js';
import { EXIT_OK } from '../harness.js';

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
    const gh = (args: string[]): string => {
      const result = spawnSync('gh', args, {
        cwd,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      if (result.status !== 0 || result.error)
        throw new Error('GitHub CLI is unavailable or signed out; run gh auth login');
      return result.stdout.trim();
    };
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(options.pullRequest);
    const repository =
      options.repository ??
      url?.[1] ??
      gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (url && options.repository && options.repository !== url[1])
      throw new Error('PR URL and --repo identify different repositories');
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? gh(['auth', 'token']);
    const client = new GitHubClient(token);
    const { login } = await client.currentUser();
    const result = await runGitHubReview({
      repository,
      number: Number(url?.[2] ?? options.pullRequest),
      token,
      actor: login,
      publish: options.publish,
      client,
    });
    io.stdout(`${JSON.stringify(result.review ?? { outcome: result.outcome }, null, 2)}\n`);
    return ['failed', 'changed'].includes(result.outcome) ? 1 : EXIT_OK;
  },
};
