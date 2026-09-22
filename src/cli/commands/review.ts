import { gitSource } from '../../sources/git.js';
import type { Command } from '../harness.js';
import { EXIT_OK } from '../harness.js';
import { reviewFromSource } from '../review-run.js';
import { prCommand } from './pr.js';

const USAGE = 'usage: pr-review review [--base <git-ref>]';

export function parseBase(args: readonly string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 2 && args[0] === '--base' && args[1]) {
    return args[1];
  }
  throw new Error(USAGE);
}

export const reviewCommand: Command = {
  name: 'review',
  summary: 'Review the current Git checkout against its merge base.',
  usage: USAGE,
  async run(args, context) {
    // Compatibility: `pr-review --pr <n>` has always meant the pull-request command.
    if (args[0] === '--pr') {
      return prCommand.run(args.slice(1), context);
    }

    const base = parseBase(args);
    const review = await reviewFromSource(
      gitSource({ cwd: context.cwd, ...(base === undefined ? {} : { base }) }),
    );
    context.io.stdout(`${JSON.stringify(review, null, 2)}\n`);
    return EXIT_OK;
  },
};
