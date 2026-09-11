import { describe, expect, it } from 'vitest';
import { formatAutomatedReview, parseRepositories } from '../src/watcher.js';
import type { Review } from '../src/schema.js';

describe('pull request watcher', () => {
  it('parses and deduplicates configured repositories', () => {
    expect(parseRepositories('owner/one, owner/two,owner/one')).toEqual([
      'owner/one',
      'owner/two',
    ]);
    expect(() => parseRepositories('owner')).toThrow(/owner\/repository/);
    expect(() => parseRepositories('')).toThrow(/owner\/repository/);
  });

  it('adds a head-specific, policy-versioned idempotency marker', () => {
    const review: Review = {
      schema_version: '1.0',
      input_sha256: 'a'.repeat(64),
      risk: 'low',
      blocked: false,
      findings: [],
      rationale: 'No actionable defects found.',
    };
    const headSha = 'b'.repeat(40);
    const body = formatAutomatedReview(review, headSha);

    expect(body).toContain('No findings.');
    expect(body).toContain(`<!-- pr-review-agent head:${headSha} policy:2 -->`);
  });
});
