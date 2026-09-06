import { describe, expect, it } from 'vitest';
import { extractDiffPaths, partitionDiff } from '../src/diff.js';

describe('diff partitioning', () => {
  it('extracts repository-relative paths from standard diff headers', () => {
    const paths = extractDiffPaths([
      'diff --git a/src/old.ts b/src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'));

    expect([...paths]).toEqual(['src/new.ts']);
  });

  it('packs whole file sections without changing the diff text', () => {
    const first = 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+one\n';
    const second = 'diff --git a/b.ts b/b.ts\n+++ b/b.ts\n+two\n';
    const partitions = partitionDiff(`${first}${second}`, first.length + 2);

    expect(partitions).toHaveLength(2);
    expect(partitions.map((partition) => partition.text).join('')).toBe(
      `${first}${second}`,
    );
    expect([...partitions[0]!.files]).toEqual(['a.ts']);
    expect([...partitions[1]!.files]).toEqual(['b.ts']);
  });

  it('fails closed when one file cannot fit in a model request', () => {
    expect(() => partitionDiff('diff --git a/a b/a\n+value\n', 8)).toThrow(
      /single diff file exceeds/,
    );
  });
});
