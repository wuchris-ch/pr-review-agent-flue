import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { decodeDiff, MAX_DIFF_BYTES } from '../core/input.js';
import { repositoryInstructions } from './instructions.js';
import type { DiffSource, ReviewRequest } from './types.js';

const GIT_METADATA_BUFFER_BYTES = 64 * 1024;
const CANDIDATE_BASE_REFS = ['origin/main', 'main', 'origin/master', 'master'] as const;

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  maxBuffer?: number,
) => SpawnSyncReturns<Buffer>;

export const defaultGitRunner: GitRunner = (args, cwd, maxBuffer = GIT_METADATA_BUFFER_BYTES) =>
  spawnSync('git', [...args], { cwd, encoding: 'buffer', maxBuffer });

export interface GitSourceOptions {
  cwd: string;
  base?: string;
  git?: GitRunner;
}

class Git {
  constructor(
    private readonly run: GitRunner,
    private readonly cwd: string,
  ) {}

  required(args: readonly string[], maxBuffer?: number): Buffer {
    const result = this.run(args, this.cwd, maxBuffer);
    if (result.error || result.status !== 0) {
      throw new Error('unable to read the current Git repository');
    }
    return result.stdout ?? Buffer.alloc(0);
  }

  text(args: readonly string[]): string {
    return this.required(args).toString('utf8').trim();
  }

  refExists(ref: string): boolean {
    const result = this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], this.cwd);
    if (result.error) {
      throw new Error('unable to inspect Git base references');
    }
    return result.status === 0;
  }
}

function defaultBaseRef(git: Git): string {
  for (const ref of CANDIDATE_BASE_REFS) {
    if (git.refExists(ref)) {
      return ref;
    }
  }
  throw new Error('cannot find a main or master base branch');
}

/** The current checkout compared against its merge base, including tracked edits. */
export function gitSource(options: GitSourceOptions): DiffSource {
  const runner = options.git ?? defaultGitRunner;
  return {
    name: 'git',
    async fetch(): Promise<ReviewRequest> {
      const root = new Git(runner, options.cwd).text(['rev-parse', '--show-toplevel']);
      const git = new Git(runner, root);
      const base = options.base ?? defaultBaseRef(git);
      if (!git.refExists(base)) {
        throw new Error(`Git base reference does not exist: ${base}`);
      }

      const mergeBase = git.text(['merge-base', base, 'HEAD']);
      const bytes = git.required(
        ['diff', '--no-ext-diff', '--binary', mergeBase, '--'],
        MAX_DIFF_BYTES + 1,
      );
      if (!bytes.length) {
        throw new Error('there are no changes to review');
      }

      const instructions = repositoryInstructions(root);
      return {
        diff: decodeDiff(bytes),
        label: `${base}...HEAD`,
        ...(instructions === undefined ? {} : { instructions }),
      };
    },
  };
}
