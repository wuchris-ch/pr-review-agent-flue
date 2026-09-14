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
    throw new Error(`repository instructions exceed ${String(MAX_INSTRUCTIONS_BYTES)} bytes`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('repository instructions must be valid UTF-8');
  }

  return text.trim() ? text : undefined;
}
