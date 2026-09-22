import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { indexDiff } from '../../src/core/diff/parse.js';
import { decodeDiff } from '../../src/core/input.js';

const manifestPath = fileURLToPath(new URL('../../evals/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  sets: Record<string, string>;
  cases: Array<{
    id: string;
    sets: string[];
    diff: string;
    instructions?: string;
    blocked: boolean;
    expect?: Array<{ file: string; line: number; severity?: string }>;
  }>;
};

/**
 * The eval manifest is data, and data rots. These checks run with the unit
 * suite so a malformed case diff or a stale expectation fails in seconds
 * rather than after a paid eval run.
 */
describe('eval manifest', () => {
  it('declares unique case identifiers in known sets', () => {
    const ids = manifest.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of manifest.cases) {
      expect(testCase.sets.length).toBeGreaterThan(0);
      for (const set of testCase.sets) {
        expect(Object.keys(manifest.sets)).toContain(set);
      }
    }
  });

  it('keeps the holdout set disjoint from the tuning sets', () => {
    for (const testCase of manifest.cases) {
      if (testCase.sets.includes('holdout')) {
        expect(testCase.sets).toEqual(['holdout']);
      }
    }
  });

  it('keeps every set balanced between blocked and clean cases', () => {
    for (const set of Object.keys(manifest.sets)) {
      const cases = manifest.cases.filter((testCase) => testCase.sets.includes(set));
      expect(cases.some((testCase) => testCase.blocked)).toBe(true);
      expect(cases.some((testCase) => !testCase.blocked)).toBe(true);
    }
  });

  it('parses every case diff and resolves every expected location', () => {
    for (const testCase of manifest.cases) {
      const path = resolve(dirname(manifestPath), testCase.diff);
      const diff = decodeDiff(readFileSync(path));
      const files = indexDiff(diff.text);
      if (testCase.instructions) {
        const guidance = readFileSync(
          resolve(dirname(manifestPath), testCase.instructions),
          'utf8',
        );
        expect(guidance.trim().length).toBeGreaterThan(0);
        expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
      }

      for (const expected of testCase.expect ?? []) {
        const anchors = files
          .flatMap((file) => file.hunks)
          .flatMap((hunk) => hunk.anchors)
          .filter((anchor) => anchor.target);
        expect(
          anchors.some((anchor) => anchor.file === expected.file && anchor.line === expected.line),
          `${testCase.id} expects ${expected.file}:${expected.line}`,
        ).toBe(true);
      }
    }
  });
});
