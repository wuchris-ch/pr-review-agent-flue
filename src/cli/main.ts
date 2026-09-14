import { agentCommand } from './commands/agent.js';
import { prCommand } from './commands/pr.js';
import { reviewCommand } from './commands/review.js';
import { watchCommand } from './commands/watch.js';
import {
  type Command,
  type CommandContext,
  type CommandIo,
  defaultIo,
  EXIT_FAILED,
  EXIT_OK,
  runCommand,
} from './harness.js';

export const COMMANDS: readonly Command[] = [reviewCommand, prCommand, agentCommand, watchCommand];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

function help(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    'usage: pr-review <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
  ].join('\n');
}

/**
 * Dispatch a command.
 *
 * Bin entries call `runCli` with their command already prefixed, so the
 * documented script paths and binary names keep working while all four
 * share one implementation.
 */
export async function runCli(
  argv: readonly string[],
  io: CommandIo = defaultIo,
  cwd: string = process.cwd(),
): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    io.stdout(help());
    return EXIT_OK;
  }

  const command = findCommand(name);
  if (!command) {
    io.stderr(`unknown command: ${name}\n${help()}`);
    return EXIT_FAILED;
  }

  const context: CommandContext = { io, cwd };
  return runCommand(command, rest, context);
}
