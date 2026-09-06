import { describe, expect, it } from 'vitest';
import {
  fetchPullRequestDiff,
  formatGitHubReview,
  parsePullRequestArgs,
  publishGitHubReview,
} from '../src/pr.js';
import type { Review } from '../src/schema.js';

describe('remote pull request command', () => {
  it('parses a pull request number with optional publishing and repository', () => {
    expect(
      parsePullRequestArgs(['42', '--publish', '--repo', 'owner/project']),
    ).toEqual({
      pullRequest: '42',
      publish: true,
      repository: 'owner/project',
    });
  });

  it('accepts GitHub pull request URLs and rejects option-like references', () => {
    expect(
      parsePullRequestArgs(['https://github.com/owner/project/pull/42']),
    ).toEqual({
      pullRequest: 'https://github.com/owner/project/pull/42',
      publish: false,
    });
    expect(() => parsePullRequestArgs(['--web'])).toThrow(/usage/);
    expect(() => parsePullRequestArgs(['0'])).toThrow(/usage/);
  });

  it('fetches a diff with gh without checking out the pull request', () => {
    const calls: string[][] = [];
    const stdout = Buffer.from(
      'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
    const diff = fetchPullRequestDiff(
      { pullRequest: '42', repository: 'owner/project', publish: false },
      '/workspace',
      (args) => {
        calls.push([...args]);
        return {
          pid: 1,
          output: [null, stdout, Buffer.alloc(0)],
          stdout,
          stderr: Buffer.alloc(0),
          status: 0,
          signal: null,
        };
      },
    );

    expect(calls).toEqual([
      ['pr', 'diff', '42', '--color=never', '--repo', 'owner/project'],
    ]);
    expect(diff.text).toContain('+new');
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
          file: 'src/auth.ts',
          line: 12,
          detail: 'Do not notify @owner or trust *input*.',
        },
      ],
      rationale: 'Authorization can be bypassed.',
    };

    const body = formatGitHubReview(review);
    expect(body).toContain('BLOCKER · security');
    expect(body).toContain('`src/auth.ts:12`');
    expect(body).toContain('@\u200bowner');
    expect(body).not.toContain('@owner');
    expect(body).toContain('Authorization can be bypassed.');
  });

  it('publishes a comment review through gh without checking out code', () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const review: Review = {
      schema_version: '1.0',
      input_sha256: 'b'.repeat(64),
      risk: 'low',
      blocked: false,
      findings: [],
      rationale: 'No actionable defects found.',
    };

    publishGitHubReview(
      { pullRequest: '42', repository: 'owner/project', publish: true },
      review,
      '/workspace',
      (args, _cwd, input) => {
        calls.push({
          args: [...args],
          ...(input === undefined ? {} : { input: input.toString('utf8') }),
        });
        return {
          pid: 1,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          status: 0,
          signal: null,
        };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'pr',
      'review',
      '42',
      '--comment',
      '--body-file',
      '-',
      '--repo',
      'owner/project',
    ]);
    expect(calls[0]?.input).toContain('No actionable defects found.');
  });
});
