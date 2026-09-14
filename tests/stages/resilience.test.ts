import { describe, expect, it, vi } from 'vitest';
import { decodeDiff } from '../../src/core/input.js';
import { reviewDiffDetailed } from '../../src/review-service.js';
import { createModelStage, EXECUTION_TRIES } from '../../src/stages/model-stage.js';
import { modelOnly } from '../helpers.js';

const diff = decodeDiff(
  Buffer.from(
    'diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-return false\n+return true\n',
  ),
);

const clean = JSON.stringify({
  schema_version: '1.0',
  input_sha256: diff.sha256,
  risk: 'low',
  blocked: false,
  findings: [],
  rationale: 'Nothing actionable.',
});

const crashed = { status: 1, stdout: '', stderr: 'model request failed' };
const rejected = { status: 2, stdout: '', stderr: 'model request rejected' };

describe('transient child failures', () => {
  it('retries a crashed child with a fresh one and succeeds', async () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(crashed)
      .mockReturnValue({ status: 0, stdout: clean, stderr: '' });

    const { review } = await reviewDiffDetailed(diff, { stages: modelOnly(execute) });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(review.blocked).toBe(false);
  });

  it('gives up after a bounded number of tries', async () => {
    const execute = vi.fn(() => crashed);
    await expect(reviewDiffDetailed(diff, { stages: modelOnly(execute) })).rejects.toThrow(
      /failed with exit 1/,
    );
    expect(execute).toHaveBeenCalledTimes(EXECUTION_TRIES);
  });

  it('does not retry a rejection no retry can fix', async () => {
    const execute = vi.fn(() => rejected);
    await expect(reviewDiffDetailed(diff, { stages: modelOnly(execute) })).rejects.toThrow(
      /usable model gateway/,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records every execution failure as telemetry, not just the last', async () => {
    const outcomes: string[] = [];
    const execute = vi
      .fn()
      .mockReturnValueOnce(crashed)
      .mockReturnValue({ status: 0, stdout: clean, stderr: '' });

    await reviewDiffDetailed(diff, {
      stages: modelOnly(execute),
      onAttempt: (attempt) => outcomes.push(attempt.outcome),
    });

    expect(outcomes).toEqual(['execution', 'accepted']);
  });
});

describe('optional stage failure', () => {
  const failing = createModelStage({
    name: 'model-verify',
    optional: true,
    execute: (() => rejected) as never,
    concurrency: 1,
  });

  it('keeps the review and says the stage did not run', async () => {
    const primary = modelOnly(() => ({ status: 0, stdout: clean, stderr: '' }));
    const { review, stages } = await reviewDiffDetailed(diff, {
      stages: [...primary, failing],
    });

    expect(review.blocked).toBe(false);
    expect(stages.at(-1)).toMatchObject({ stage: 'model-verify', status: 'failed' });
    // A reader must not mistake an absent check for a passing one.
    expect(review.rationale).toContain('model-verify stage did not complete');
  });

  it('still fails the review when a required stage fails', async () => {
    await expect(reviewDiffDetailed(diff, { stages: modelOnly(() => rejected) })).rejects.toThrow();
  });
});
