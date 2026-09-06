import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  decodeDiff,
  decodeInstructions,
  MAX_DIFF_BYTES,
  MAX_INSTRUCTIONS_BYTES,
  readDiff,
  readReviewInput,
  type InputReader,
} from '../src/input.js';

function reader(): InputReader {
  return {
    readFile: vi.fn(() => Buffer.from('diff --git a/a.ts b/a.ts\n+fixed')),
    readStdin: vi.fn(() => Buffer.from('diff --git a/b.ts b/b.ts\n+safe')),
  };
}

describe('readDiff', () => {
  it('reads from stdin when no argument is provided', () => {
    const input = reader();
    expect(readDiff([], input).text).toContain('b/b.ts');
    expect(input.readStdin).toHaveBeenCalledOnce();
  });

  it('reads the path supplied by --diff', () => {
    const input = reader();
    expect(readDiff(['--diff', 'change.diff'], input).text).toContain('a/a.ts');
    expect(input.readFile).toHaveBeenCalledWith('change.diff');
  });

  it('reads optional repository instructions in either argument order', () => {
    const input = reader();
    vi.mocked(input.readFile).mockImplementation((path) => (
      Buffer.from(path === 'AGENTS.md' ? 'Prioritize authorization.' : diffText)
    ));

    const result = readReviewInput(
      ['--instructions', 'AGENTS.md', '--diff', 'change.diff'],
      input,
    );

    expect(result.diff.text).toBe(diffText);
    expect(result.instructions).toBe('Prioritize authorization.');
  });

  it('rejects invalid arguments and empty input', () => {
    expect(() => readDiff(['--unknown'], reader())).toThrow(/usage/);
    expect(() =>
      readDiff([], {
        readFile: () => Buffer.alloc(0),
        readStdin: () => Buffer.from('   '),
      }),
    ).toThrow(/must not be empty/);
  });

  it('rejects oversized diffs', () => {
    expect(() =>
      readDiff([], {
        readFile: () => Buffer.alloc(0),
        readStdin: () => Buffer.alloc(MAX_DIFF_BYTES + 1, 'x'),
      }),
    ).toThrow(/exceeds/);
  });

  it('rejects invalid or oversized repository instructions', () => {
    expect(() => decodeInstructions(Buffer.alloc(MAX_INSTRUCTIONS_BYTES + 1))).toThrow(
      /instructions exceed/,
    );
    expect(() => decodeInstructions(Buffer.from([0xff]))).toThrow(/valid UTF-8/);
  });

  it('ignores a blank repository instructions file', () => {
    expect(decodeInstructions(Buffer.from('  \n'))).toBeUndefined();
  });

  it('preserves exact bytes while decoding valid UTF-8', () => {
    const bytes = Buffer.from('diff --git a/a b/a\r\n+caf\u00e9\r\n', 'utf8');
    const input = decodeDiff(bytes);
    expect(input.bytes.equals(bytes)).toBe(true);
    expect(input.text).toBe('diff --git a/a b/a\r\n+caf\u00e9\r\n');
    expect(input.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('rejects non-UTF-8 input without replacement decoding', () => {
    expect(() => decodeDiff(Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff]))).toThrow(
      /valid UTF-8/,
    );
  });
});

const diffText = 'diff --git a/a.ts b/a.ts\n+fixed';
