#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeDiff, decodeInstructions, MAX_DIFF_BYTES } from './input.js';
import { reviewDiff } from './runner.js';
import type { Review } from './schema.js';

const GH_OUTPUT_BUFFER_BYTES = 64 * 1024;
const USAGE =
  'usage: pr-review-flue-pr <number-or-url> [--repo <owner/repo>] [--publish]';

export interface PullRequestReviewIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface PullRequestOptions {
  pullRequest: string;
  repository?: string;
  publish: boolean;
}

type GhRunner = (
  args: readonly string[],
  cwd: string,
  input?: Buffer,
  maxBuffer?: number,
) => SpawnSyncReturns<Buffer>;

const defaultIo: PullRequestReviewIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const runGh: GhRunner = (
  args,
  cwd,
  input,
  maxBuffer = MAX_DIFF_BYTES + 1,
) =>
  spawnSync('gh', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer,
    ...(input === undefined ? {} : { input }),
  });

function isPullRequestReference(value: string): boolean {
  if (/^[1-9][0-9]*$/.test(value)) {
    return true;
  }
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(
    value,
  );
}

function isRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export function parsePullRequestArgs(args: readonly string[]): PullRequestOptions {
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
      if (!value || repository !== undefined || !isRepository(value)) {
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

  if (pullRequest === undefined || !isPullRequestReference(pullRequest)) {
    throw new Error(USAGE);
  }

  return {
    pullRequest,
    publish,
    ...(repository === undefined ? {} : { repository }),
  };
}

function repositoryInstructions(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'buffer',
    maxBuffer: GH_OUTPUT_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }

  const root = (result.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
  if (!root) {
    return undefined;
  }
  const instructionsPath = `${root}/AGENTS.md`;
  return existsSync(instructionsPath)
    ? decodeInstructions(readFileSync(instructionsPath))
    : undefined;
}

export function fetchPullRequestDiff(
  options: PullRequestOptions,
  cwd: string,
  runner: GhRunner = runGh,
): ReturnType<typeof decodeDiff> {
  const args = ['pr', 'diff', options.pullRequest, '--color=never'];
  if (options.repository !== undefined) {
    args.push('--repo', options.repository);
  }

  const result = runner(args, cwd);
  if (result.error || result.status !== 0) {
    throw new Error('unable to fetch the pull request diff with GitHub CLI');
  }

  const bytes = result.stdout ?? Buffer.alloc(0);
  if (!bytes.length) {
    throw new Error('the pull request has no changes to review');
  }
  return decodeDiff(bytes);
}

function safeMarkdown(value: string): string {
  return value
    .replaceAll('@', '@\u200b')
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function inlineCode(value: string): string {
  const longestRun = (value.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const padding = longestRun > 0 ? ' ' : '';
  return `${fence}${padding}${value.replaceAll('\n', ' ').replaceAll('\r', ' ')}${padding}${fence}`;
}

export function formatGitHubReview(review: Review): string {
  const lines = [
    '## PR review agent',
    '',
    `**Risk:** ${review.risk}  `,
    `**Blocking findings:** ${review.blocked ? 'yes' : 'no'}`,
    '',
  ];

  if (review.findings.length === 0) {
    lines.push('No findings.', '');
  } else {
    lines.push('### Findings', '');
    for (const [index, finding] of review.findings.entries()) {
      const location = inlineCode(`${finding.file}:${finding.line}`);
      lines.push(
        `${index + 1}. **${finding.severity.toUpperCase()} · ${finding.category}** at ${location}`,
        `   ${safeMarkdown(finding.detail)}`,
        '',
      );
    }
  }

  lines.push('### Rationale', '', safeMarkdown(review.rationale), '');
  return lines.join('\n');
}

export function publishGitHubReview(
  options: PullRequestOptions,
  review: Review,
  cwd: string,
  runner: GhRunner = runGh,
): void {
  const args = [
    'pr',
    'review',
    options.pullRequest,
    '--comment',
    '--body-file',
    '-',
  ];
  if (options.repository !== undefined) {
    args.push('--repo', options.repository);
  }

  const body = Buffer.from(formatGitHubReview(review), 'utf8');
  if (body.length > 60 * 1024) {
    throw new Error('review is too large to publish safely');
  }
  const result = runner(args, cwd, body, GH_OUTPUT_BUFFER_BYTES);
  if (result.error || result.status !== 0) {
    throw new Error('review completed, but GitHub rejected the review comment');
  }
}

export function main(
  args: readonly string[] = process.argv.slice(2),
  io: PullRequestReviewIo = defaultIo,
  cwd: string = process.cwd(),
): number {
  try {
    const options = parsePullRequestArgs(args);
    const diff = fetchPullRequestDiff(options, cwd);
    const instructions = options.repository === undefined
      ? repositoryInstructions(cwd)
      : undefined;
    const review = reviewDiff(diff, undefined, {
      ...(instructions === undefined ? {} : { instructions }),
    });
    io.stdout(`${JSON.stringify(review, null, 2)}\n`);

    if (options.publish) {
      publishGitHubReview(options, review, cwd);
      io.stderr('GitHub review comment published.\n');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`review failed: ${message}\n`);
    return 1;
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
  process.exitCode = main();
}
