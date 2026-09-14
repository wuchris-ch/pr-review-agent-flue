#!/usr/bin/env node
// Compatibility entry point. Every command shares src/cli/main.ts; this file
// only fixes the subcommand so the documented script path and binary name keep
// working.
import { type CommandIo, defaultIo, runEntrypoint } from './cli/harness.js';
import { runCli } from './cli/main.js';

export function main(
  args: readonly string[] = process.argv.slice(2),
  io: CommandIo = defaultIo,
  cwd: string = process.cwd(),
): Promise<number> {
  return runCli(['agent', ...args], io, cwd);
}

runEntrypoint(import.meta.url, () => main());
