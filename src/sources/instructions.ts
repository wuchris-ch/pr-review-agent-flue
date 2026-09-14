import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeInstructions } from '../core/input.js';

export const INSTRUCTIONS_FILENAME = 'AGENTS.md';

/**
 * Repository review guidance, when the checkout has any.
 *
 * Shared by the local-git and pull-request sources, which previously each
 * carried their own copy of this lookup.
 */
export function repositoryInstructions(repositoryRoot: string): string | undefined {
  const path = join(repositoryRoot, INSTRUCTIONS_FILENAME);
  return existsSync(path) ? decodeInstructions(readFileSync(path)) : undefined;
}
