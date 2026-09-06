#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readReviewInput } from './input.js';
import { reviewDiff } from './runner.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export function main(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = defaultIo,
): number {
  try {
    const input = readReviewInput(args);
    const review = reviewDiff(input.diff, undefined, {
      ...(input.instructions === undefined
        ? {}
        : { instructions: input.instructions }),
    });
    io.stdout(`${JSON.stringify(review)}\n`);
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
