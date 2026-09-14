import { readFileSync } from 'node:fs';
import { decodeDiff, decodeInstructions } from '../core/input.js';
import type { DiffSource, ReviewRequest } from './types.js';

export interface InputReader {
  readFile(path: string): Buffer;
  readStdin(): Buffer;
}

export const defaultReader: InputReader = {
  readFile: (path) => readFileSync(path),
  readStdin: () => readFileSync(0),
};

export interface LocalSourceOptions {
  diffPath?: string;
  instructionsPath?: string;
  reader?: InputReader;
}

/** A diff supplied directly, from a file or standard input. */
export function localSource(options: LocalSourceOptions = {}): DiffSource {
  const reader = options.reader ?? defaultReader;
  return {
    name: 'local',
    async fetch(): Promise<ReviewRequest> {
      const diff = decodeDiff(
        options.diffPath ? reader.readFile(options.diffPath) : reader.readStdin(),
      );
      const instructions = options.instructionsPath
        ? decodeInstructions(reader.readFile(options.instructionsPath))
        : undefined;
      return {
        diff,
        label: options.diffPath ?? 'stdin',
        ...(instructions === undefined ? {} : { instructions }),
      };
    },
  };
}
