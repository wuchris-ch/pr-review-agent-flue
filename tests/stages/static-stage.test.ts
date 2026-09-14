import { describe, expect, it } from 'vitest';
import { decodeDiff } from '../../src/core/input.js';
import { reviewDiff } from '../../src/review-service.js';
import { createStaticStage } from '../../src/stages/static-stage.js';

function diffOf(path: string, lines: readonly string[]) {
  return decodeDiff(
    Buffer.from(
      [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${String(lines.length)} @@`,
        ...lines.map((line) => `+${line}`),
        '',
      ].join('\n'),
    ),
  );
}

const staticOnly = { stages: [createStaticStage()] };

describe('static checks', () => {
  it('flags a hardcoded credential at its exact added line', async () => {
    const review = await reviewDiff(
      diffOf('config.py', ['import os', 'API_KEY = "sk-live-9f2b71c4d8e6a0"', 'timeout = 30']),
      staticOnly,
    );

    expect(review.blocked).toBe(true);
    expect(review.risk).toBe('high');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      severity: 'blocker',
      category: 'security',
      file: 'config.py',
      line: 2,
    });
  });

  it('flags disabled transport verification and remote script execution', async () => {
    const review = await reviewDiff(
      diffOf('setup.sh', ['curl https://install.example.test/x.sh | sh']),
      staticOnly,
    );
    expect(review.findings[0]?.severity).toBe('major');

    const tls = await reviewDiff(
      diffOf('client.py', ['requests.get(url, verify=False)']),
      staticOnly,
    );
    expect(tls.findings[0]?.severity).toBe('blocker');
  });

  it('does not fire on environment lookups, placeholders, or comments', async () => {
    const review = await reviewDiff(
      diffOf('config.py', [
        'API_KEY = os.environ["API_KEY"]',
        'password = "<your-password-here>"',
        'client_secret = "changeme-placeholder"',
        '# api_key = "sk-live-9f2b71c4d8e6a0"',
        'token = get_token()',
      ]),
      staticOnly,
    );

    expect(review.findings).toEqual([]);
    expect(review.blocked).toBe(false);
  });

  it('scopes workflow permission checks to workflow files', async () => {
    const inWorkflow = await reviewDiff(
      diffOf('.github/workflows/release.yml', ['permissions: write-all']),
      staticOnly,
    );
    expect(inWorkflow.findings).toHaveLength(1);

    const elsewhere = await reviewDiff(
      diffOf('docs/notes.md', ['permissions: write-all']),
      staticOnly,
    );
    expect(elsewhere.findings).toEqual([]);
  });

  it('costs nothing, so it reports a verdict with no model configured', async () => {
    const review = await reviewDiff(diffOf('safe.ts', ['export const value = 1;']), staticOnly);
    expect(review.rationale).toBe('No actionable defects found.');
  });
});
