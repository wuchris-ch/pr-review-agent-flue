import { agentCommand } from './commands/agent.js';
import { feedbackCommand } from './commands/feedback.js';
import { prCommand } from './commands/pr.js';
import { reviewCommand } from './commands/review.js';
import { doctorCommand, initCommand } from './commands/setup.js';
import {
  type Command,
  type CommandContext,
  type CommandIo,
  defaultIo,
  EXIT_FAILED,
  EXIT_OK,
  runCommand,
} from './harness.js';

export const COMMANDS: readonly Command[] = [
  reviewCommand,
  prCommand,
  agentCommand,
  initCommand,
  doctorCommand,
  feedbackCommand,
  {
    name: 'serve',
    summary: 'Run the GitHub App webhook receiver.',
    usage: 'usage: pr-review serve',
    async run(args) {
      if (args.length) throw new Error('usage: pr-review serve');
      const { serveApp } = await import('../github/app.js');
      await serveApp();
      return 0;
    },
  },
];

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
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) {
    io.stdout(`${command.usage}\n`);
    return EXIT_OK;
  }
  return runCommand(command, rest, context);
}
