#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runFlueReview } from './runtime.js';

async function main(): Promise<void> {
  const input = readFileSync(0);
  if (!input.length || input.length > 1024 * 1024) throw new Error('invalid input size');
  const output = await runFlueReview(
    new TextDecoder('utf-8', { fatal: true }).decode(input),
    'platform',
  );
  process.stdout.write(output);
}
main().catch(() => {
  process.stderr.write('specialist request failed; check worker provider configuration\n');
  process.exitCode = 1;
});
