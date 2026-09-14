import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { decodeDiff, MAX_DIFF_BYTES } from '../core/input.js';
import type { Review } from '../core/schema.js';
import { formatGitHubReview, MAX_REVIEW_BODY_BYTES } from '../render/github.js';
import { repositoryInstructions } from './instructions.js';
import type { DiffSource, ReviewRequest } from './types.js';

const GH_OUTPUT_BUFFER_BYTES = 64 * 1024;

export type GhRunner = (
  args: readonly string[],
  cwd: string,
  input?: Buffer,
  maxBuffer?: number,
) => SpawnSyncReturns<Buffer>;

export const defaultGhRunner: GhRunner = (args, cwd, input, maxBuffer = MAX_DIFF_BYTES + 1) =>
  spawnSync('gh', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer,
    ...(input === undefined ? {} : { input }),
  });

export interface PullRequestTarget {
  pullRequest: string;
  repository?: string;
}

export interface GhSourceOptions extends PullRequestTarget {
  cwd: string;
  gh?: GhRunner;
  /** Read AGENTS.md from the working checkout. Skipped for an explicit repository. */
  useLocalInstructions?: boolean;
}

function withRepository(args: string[], target: PullRequestTarget): string[] {
  return target.repository === undefined ? args : [...args, '--repo', target.repository];
}

function localRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'buffer',
    maxBuffer: GH_OUTPUT_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const root = (result.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
  return root || undefined;
}

/** One pull request diff, read through the authenticated GitHub CLI. */
export function ghSource(options: GhSourceOptions): DiffSource {
  const gh = options.gh ?? defaultGhRunner;
  return {
    name: 'gh',
    async fetch(): Promise<ReviewRequest> {
      const args = withRepository(['pr', 'diff', options.pullRequest, '--color=never'], options);
      const result = gh(args, options.cwd);
      if (result.error || result.status !== 0) {
        throw new Error('unable to fetch the pull request diff with GitHub CLI');
      }

      const bytes = result.stdout ?? Buffer.alloc(0);
      if (!bytes.length) {
        throw new Error('the pull request has no changes to review');
      }

      const root = options.useLocalInstructions ? localRoot(options.cwd) : undefined;
      const instructions = root ? repositoryInstructions(root) : undefined;
      return {
        diff: decodeDiff(bytes),
        label: options.repository
          ? `${options.repository}#${options.pullRequest}`
          : options.pullRequest,
        ...(instructions === undefined ? {} : { instructions }),
      };
    },
  };
}

/** Publish one COMMENT review through the GitHub CLI. */
export function publishGitHubReview(
  target: PullRequestTarget,
  review: Review,
  cwd: string,
  gh: GhRunner = defaultGhRunner,
): void {
  const body = Buffer.from(formatGitHubReview(review), 'utf8');
  if (body.length > MAX_REVIEW_BODY_BYTES) {
    throw new Error('review is too large to publish safely');
  }

  const args = withRepository(
    ['pr', 'review', target.pullRequest, '--comment', '--body-file', '-'],
    target,
  );
  const result = gh(args, cwd, body, GH_OUTPUT_BUFFER_BYTES);
  if (result.error || result.status !== 0) {
    throw new Error('review completed, but GitHub rejected the review comment');
  }
}
