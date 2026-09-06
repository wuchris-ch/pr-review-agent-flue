import { describe, expect, it } from 'vitest';
import { ReviewValidationError, validateReview } from '../src/schema.js';

const safeReview = {
  schema_version: '1.0',
  input_sha256: 'a'.repeat(64),
  risk: 'low',
  blocked: false,
  findings: [],
  rationale: 'The change preserves behavior and adds no security exposure.',
};

describe('validateReview', () => {
  it('accepts the exact output contract', () => {
    expect(validateReview(safeReview)).toEqual(safeReview);
  });

  it('requires positive integer line numbers', () => {
    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'high',
        blocked: true,
        findings: [
          {
            severity: 'blocker',
            category: 'security',
            file: 'src/db.ts',
            line: 0,
            detail: 'Unsafe query construction.',
          },
        ],
      }),
    ).toThrow(ReviewValidationError);
  });

  it('rejects absolute and parent-traversal finding paths', () => {
    for (const file of [
      '.',
      '/etc/passwd',
      '\\etc\\passwd',
      '../src/auth.ts',
      'src/../../secrets.txt',
      'C:\\secrets.txt',
      'C:secrets.txt',
      '\\\\server\\share\\file.ts',
      'https://example.test/file.ts',
      ' src/auth.ts',
      'src/auth.ts ',
    ]) {
      expect(() =>
        validateReview({
          ...safeReview,
          risk: 'high',
          blocked: true,
          findings: [
            {
              severity: 'blocker',
              category: 'security',
              file,
              line: 1,
              detail: 'Unsafe path.',
            },
          ],
        }),
      ).toThrow(/does not match review schema/);
    }

    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'high',
        blocked: true,
        findings: [
          {
            severity: 'blocker',
            category: 'security',
            file: '',
            line: 1,
            detail: 'Unsafe path.',
          },
        ],
      }),
    ).toThrow(/does not match review schema/);
  });

  it('rejects keys outside the contract', () => {
    expect(() => validateReview({ ...safeReview, debug: true })).toThrow(
      ReviewValidationError,
    );
  });

  it('rejects whitespace-only finding details and rationale', () => {
    expect(() => validateReview({ ...safeReview, rationale: ' \n\t ' })).toThrow(
      /does not match review schema/,
    );

    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'medium',
        blocked: true,
        findings: [
          {
            severity: 'major',
            category: 'correctness',
            file: 'src/cache.ts',
            line: 8,
            detail: '   ',
          },
        ],
      }),
    ).toThrow(/does not match review schema/);
  });

  it('requires blocker and major findings to block the review', () => {
    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'medium',
        findings: [
          {
            severity: 'major',
            category: 'correctness',
            file: 'src/cache.ts',
            line: 8,
            detail: 'The new branch returns stale data.',
          },
        ],
      }),
    ).toThrow(/blocked must be true/);
  });

  it('rejects blocked output without a blocker or major finding', () => {
    expect(() => validateReview({ ...safeReview, blocked: true })).toThrow(
      /blocked must be true/,
    );
  });

  it('enforces risk consistency', () => {
    expect(() => validateReview({ ...safeReview, risk: 'high' })).toThrow(
      /risk must be/,
    );
    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'medium',
        blocked: true,
        findings: [
          {
            severity: 'blocker',
            category: 'security',
            file: 'src/auth.ts',
            line: 4,
            detail: 'Authorization is bypassed.',
          },
        ],
      }),
    ).toThrow(/risk must be/);

    const majorOnly = {
      ...safeReview,
      risk: 'high',
      blocked: true,
      findings: [
        {
          severity: 'major',
          category: 'correctness',
          file: 'src/cache.ts',
          line: 7,
          detail: 'The new branch returns stale data.',
        },
      ],
    };
    expect(() => validateReview(majorOnly)).toThrow(/risk must be/);
    expect(validateReview({ ...majorOnly, risk: 'medium' }).risk).toBe('medium');

    expect(() =>
      validateReview({
        ...safeReview,
        risk: 'medium',
        findings: [
          {
            severity: 'minor',
            category: 'style',
            file: 'src/format.ts',
            line: 3,
            detail: 'Naming is inconsistent.',
          },
        ],
      }),
    ).toThrow(/risk must be/);
  });
});
