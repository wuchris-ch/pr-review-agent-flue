import { describe, expect, it } from 'vitest';
import { REVIEW_SYSTEM_PROMPT } from '../src/agents/system-prompt.js';

describe('review system prompt', () => {
  it('requires concrete diff evidence for supply-chain findings', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      'A new, unfamiliar, or major-version dependency is not by itself evidence',
    );
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      'Do not infer compromise solely from a transitive package name.',
    );
  });

  it('defines critical severity by concrete impact', () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      'plaintext credential or secret disclosure',
    );
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      'Use major for a material defect that must be fixed before merge',
    );
  });
});
