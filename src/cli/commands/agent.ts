import { localSource } from '../../sources/local.js';
import type { Command } from '../harness.js';
import { EXIT_OK } from '../harness.js';
import { reviewFromSource } from '../review-run.js';

const USAGE = 'usage: pr-review-agent [--diff <path>] [--instructions <path>]';

export interface AgentArgs {
  diffPath?: string;
  instructionsPath?: string;
}

export function parseAgentArgs(args: readonly string[]): AgentArgs {
  const parsed: AgentArgs = {};

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if ((option !== '--diff' && option !== '--instructions') || !value) {
      throw new Error(USAGE);
    }
    if (option === '--diff') {
      if (parsed.diffPath !== undefined) {
        throw new Error('the --diff option may be supplied only once');
      }
      parsed.diffPath = value;
    } else {
      if (parsed.instructionsPath !== undefined) {
        throw new Error('the --instructions option may be supplied only once');
      }
      parsed.instructionsPath = value;
    }
  }

  return parsed;
}

export const agentCommand: Command = {
  name: 'agent',
  summary: 'Review a raw unified diff from a file or standard input.',
  usage: USAGE,
  async run(args, { io }) {
    const review = await reviewFromSource(localSource(parseAgentArgs(args)));
    io.stdout(`${JSON.stringify(review)}\n`);
    return EXIT_OK;
  },
};
