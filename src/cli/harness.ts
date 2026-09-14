import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const defaultIo: CommandIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface CommandContext {
  readonly io: CommandIo;
  readonly cwd: string;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: readonly string[], context: CommandContext): Promise<number>;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * One place that turns a thrown error into the process contract.
 *
 * Each entry point used to carry its own copy of this try/catch, which is
 * how they drifted into reporting failures slightly differently.
 */
export async function runCommand(
  command: Command,
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  try {
    return await command.run(args, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.io.stderr(`review failed: ${message}\n`);
    return EXIT_FAILED;
  }
}

/** True when `moduleUrl` is the script Node was started with. */
export function isMainModule(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Wire a bin entry to a fixed command, preserving the documented script paths. */
export function runEntrypoint(moduleUrl: string, run: () => Promise<number>): void {
  if (!isMainModule(moduleUrl)) {
    return;
  }
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`review failed: ${message}\n`);
      process.exitCode = EXIT_FAILED;
    },
  );
}
