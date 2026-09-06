import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_INSTRUCTIONS_BYTES = 16 * 1024;

export interface DiffInput {
  bytes: Buffer;
  text: string;
  sha256: string;
}

export interface ReviewInput {
  diff: DiffInput;
  instructions?: string;
}

export interface InputReader {
  readFile(path: string): Buffer;
  readStdin(): Buffer;
}

const defaultReader: InputReader = {
  readFile: (path) => readFileSync(path),
  readStdin: () => readFileSync(0),
};

export function diffSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function decodeDiff(bytes: Buffer): DiffInput {
  if (bytes.length > MAX_DIFF_BYTES) {
    throw new Error(`diff input exceeds ${String(MAX_DIFF_BYTES)} bytes`);
  }

  const sha256 = diffSha256(bytes);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('diff input must be valid UTF-8');
  }

  if (!text.trim()) {
    throw new Error('diff input must not be empty');
  }

  return { bytes, text, sha256 };
}

export function decodeInstructions(bytes: Buffer): string | undefined {
  if (bytes.length > MAX_INSTRUCTIONS_BYTES) {
    throw new Error(
      `repository instructions exceed ${String(MAX_INSTRUCTIONS_BYTES)} bytes`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('repository instructions must be valid UTF-8');
  }

  return text.trim() ? text : undefined;
}

export function readReviewInput(
  args: readonly string[],
  reader: InputReader = defaultReader,
): ReviewInput {
  let diffPath: string | undefined;
  let instructionsPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if ((argument !== '--diff' && argument !== '--instructions') || !value) {
      throw new Error(
        'usage: pr-review-flue-agent [--diff <path>] [--instructions <path>]',
      );
    }

    if (argument === '--diff') {
      if (diffPath !== undefined) {
        throw new Error('the --diff option may be supplied only once');
      }
      diffPath = value;
    } else {
      if (instructionsPath !== undefined) {
        throw new Error('the --instructions option may be supplied only once');
      }
      instructionsPath = value;
    }
    index += 1;
  }

  const diff = decodeDiff(
    diffPath ? reader.readFile(diffPath) : reader.readStdin(),
  );
  const instructions = instructionsPath
    ? decodeInstructions(reader.readFile(instructionsPath))
    : undefined;

  return {
    diff,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

export function readDiff(
  args: readonly string[],
  reader: InputReader = defaultReader,
): DiffInput {
  return readReviewInput(args, reader).diff;
}
