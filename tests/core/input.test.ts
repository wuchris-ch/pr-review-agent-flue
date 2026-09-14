import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeDiff,
  decodeInstructions,
  MAX_DIFF_BYTES,
  MAX_INSTRUCTIONS_BYTES,
} from '../../src/core/input.js';

describe('decodeDiff', () => {
  it('preserves exact bytes while decoding valid UTF-8', () => {
    const bytes = Buffer.from('diff --git a/a b/a\r\n+caf\u00e9\r\n', 'utf8');
    const input = decodeDiff(bytes);

    expect(input.bytes.equals(bytes)).toBe(true);
    expect(input.text).toBe('diff --git a/a b/a\r\n+caf\u00e9\r\n');
    expect(input.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects non-UTF-8 input without replacement decoding', () => {
    expect(() => decodeDiff(Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff]))).toThrow(/valid UTF-8/);
  });

  it('rejects empty and oversized diffs', () => {
    expect(() => decodeDiff(Buffer.from('   '))).toThrow(/must not be empty/);
    expect(() => decodeDiff(Buffer.alloc(MAX_DIFF_BYTES + 1, 'x'))).toThrow(/exceeds/);
  });
});

describe('decodeInstructions', () => {
  it('rejects invalid or oversized repository instructions', () => {
    expect(() => decodeInstructions(Buffer.alloc(MAX_INSTRUCTIONS_BYTES + 1))).toThrow(
      /instructions exceed/,
    );
    expect(() => decodeInstructions(Buffer.from([0xff]))).toThrow(/valid UTF-8/);
  });

  it('ignores a blank repository instructions file', () => {
    expect(decodeInstructions(Buffer.from('  \n'))).toBeUndefined();
  });
});
