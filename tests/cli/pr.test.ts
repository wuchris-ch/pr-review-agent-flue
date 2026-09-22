import { describe, expect, it } from 'vitest';
import { parsePullRequestArgs } from '../../src/cli/commands/pr.js';
import type { Review } from '../../src/core/schema.js';
import { formatGitHubReview } from '../../src/render/github.js';

describe('remote pull request command', () => {
  it('parses a pull request number with optional publishing and repository', () => {
    expect(parsePullRequestArgs(['42', '--publish', '--repo', 'owner/project'])).toEqual({
      pullRequest: '42',
      publish: true,
      repository: 'owner/project',
    });
  });

  it('accepts GitHub pull request URLs and rejects option-like references', () => {
    expect(parsePullRequestArgs(['https://github.com/owner/project/pull/42'])).toEqual({
      pullRequest: 'https://github.com/owner/project/pull/42',
      publish: false,
    });
    expect(() => parsePullRequestArgs(['--web'])).toThrow(/usage/);
    expect(() => parsePullRequestArgs(['0'])).toThrow(/usage/);
  });

  it('formats findings as a review body and neutralizes mentions', () => {
    const review: Review = {
      schema_version: '1.0',
      input_sha256: 'a'.repeat(64),
      risk: 'high',
      blocked: true,
      findings: [
        {
          severity: 'blocker',
          category: 'security',
          file: 'src/account_lookup.ts',
          line: 12,
          detail: 'Do not notify @owner or trust *input*.',
        },
      ],
      rationale: 'Authorization can be bypassed.',
    };

    const body = formatGitHubReview(review);
    expect(body).toContain('BLOCKER · security');
    expect(body).toContain('`src/account_lookup.ts:12`');
    expect(body).toContain('@\u200bowner');
    expect(body).not.toContain('@owner');
    expect(body).toContain('Authorization can be bypassed.');
  });

  it('keeps backticks in a filename inside one literal code span', () => {
    const body = formatGitHubReview({
      schema_version: '1.0',
      input_sha256: 'c'.repeat(64),
      risk: 'high',
      blocked: true,
      findings: [
        {
          severity: 'blocker',
          category: 'security',
          file: 'src/`![image](https://example.test/a)_name.ts',
          line: 7,
          detail: 'Unsafe query.',
        },
      ],
      rationale: 'Unsafe query.',
    });
    expect(body).toContain('`` src/`![image](https://example.test/a)_name.ts:7 ``');
  });
});
