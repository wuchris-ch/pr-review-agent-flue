#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeDiff, decodeInstructions, MAX_DIFF_BYTES } from './input.js';
import { main as pullRequestMain } from './pr.js';
import { reviewDiff } from './runner.js';

const GIT_METADATA_BUFFER_BYTES = 64 * 1024;

export interface ReviewCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIo: ReviewCommandIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function runGit(
  args: readonly string[],
  cwd: string,
  maxBuffer = GIT_METADATA_BUFFER_BYTES,
): SpawnSyncReturns<Buffer> {
  return spawnSync('git', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer,
  });
}

function requiredGitOutput(args: readonly string[], cwd: string): Buffer {
  const result = runGit(args, cwd);
  if (result.error || result.status !== 0) {
    throw new Error('unable to read the current Git repository');
  }
  return result.stdout ?? Buffer.alloc(0);
}

function refExists(ref: string, cwd: string): boolean {
  const result = runGit(
    ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    cwd,
  );
  if (result.error) {
    throw new Error('unable to inspect Git base references');
  }
  return result.status === 0;
}

function defaultBaseRef(cwd: string): string {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    if (refExists(ref, cwd)) {
      return ref;
    }
  }
  throw new Error('cannot find a main or master base branch');
}

export interface CurrentReviewInput {
  diff: ReturnType<typeof decodeDiff>;
  instructions?: string;
}

export function readCurrentReviewInput(
  cwd: string,
  requestedBase?: string,
): CurrentReviewInput {
  const repositoryRoot = requiredGitOutput(
    ['rev-parse', '--show-toplevel'],
    cwd,
  ).toString('utf8').trim();
  const base = requestedBase ?? defaultBaseRef(repositoryRoot);
  if (!refExists(base, repositoryRoot)) {
    throw new Error(`Git base reference does not exist: ${base}`);
  }

  const mergeBase = requiredGitOutput(
    ['merge-base', base, 'HEAD'],
    repositoryRoot,
  ).toString('utf8').trim();
  const result = runGit(
    ['diff', '--no-ext-diff', '--binary', mergeBase, '--'],
    repositoryRoot,
    MAX_DIFF_BYTES + 1,
  );
  if (result.error || result.status !== 0) {
    throw new Error('unable to create the review diff');
  }

  const diffBytes = result.stdout ?? Buffer.alloc(0);
  if (!diffBytes.length) {
    throw new Error('there are no changes to review');
  }

  const instructionsPath = `${repositoryRoot}/AGENTS.md`;
  const instructions = existsSync(instructionsPath)
    ? decodeInstructions(readFileSync(instructionsPath))
    : undefined;

  return {
    diff: decodeDiff(diffBytes),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function parseBase(args: readonly string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 2 && args[0] === '--base' && args[1]) {
    return args[1];
  }
  throw new Error('usage: pr-review-flue [--base <git-ref>]');
}

export function main(
  args: readonly string[] = process.argv.slice(2),
  io: ReviewCommandIo = defaultIo,
  cwd: string = process.cwd(),
): number {
  if (args[0] === '--pr') {
    return pullRequestMain(args.slice(1), io, cwd);
  }

  try {
    const input = readCurrentReviewInput(cwd, parseBase(args));
    const review = reviewDiff(input.diff, undefined, {
      ...(input.instructions === undefined
        ? {}
        : { instructions: input.instructions }),
    });
    io.stdout(`${JSON.stringify(review, null, 2)}\n`);
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
