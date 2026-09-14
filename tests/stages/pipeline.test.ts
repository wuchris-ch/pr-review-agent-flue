import { describe, expect, it, vi } from 'vitest';
import { decodeDiff } from '../../src/core/input.js';
import { createDefaultStages, reviewDiffDetailed } from '../../src/review-service.js';
import { mergeFindings } from '../../src/stages/pipeline.js';
import type { ReviewStage } from '../../src/stages/types.js';

const diff = decodeDiff(
  Buffer.from(
    'diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-return false\n+return true\n',
  ),
);

function proposal(findings: unknown[], risk: string, blocked: boolean) {
  return JSON.stringify({
    schema_version: '1.0',
    input_sha256: diff.sha256,
    risk,
    blocked,
    findings,
    rationale: 'Reviewed the change.',
  });
}

const clean = proposal([], 'low', false);
const blocking = proposal(
  [
    {
      severity: 'blocker',
      category: 'security',
      evidence: { anchor: 'F1N1', quote: 'return true' },
      detail: 'Authorization always succeeds.',
    },
  ],
  'high',
  true,
);

const config = {
  concurrency: 1,
  partitionTimeoutMs: 5_000,
  deadlineMs: 30_000,
  verifyEnabled: true,
  verifyMaxPartitions: 4,
};

describe('stage gating', () => {
  it('runs the second opinion only when nothing blocking was found', async () => {
    const execute = vi.fn(() => ({ status: 0, stdout: clean, stderr: '' }));
    const { stages } = await reviewDiffDetailed(diff, {
      config,
      execute: execute as never,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(stages.map((stage) => `${stage.stage}:${stage.status}`)).toEqual([
      'static-checks:ran',
      'model-review:ran',
      'model-verify:ran',
    ]);
    expect(execute.mock.calls[1]?.[0]).toContain('A first reviewer found no blocking defect');
  });

  it('skips the second opinion once a blocking finding exists', async () => {
    const execute = vi.fn(() => ({ status: 0, stdout: blocking, stderr: '' }));
    const { review, stages } = await reviewDiffDetailed(diff, {
      config,
      execute: execute as never,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(stages.at(-1)).toMatchObject({ stage: 'model-verify', status: 'skipped' });
    expect(review.blocked).toBe(true);
  });

  it('skips the second opinion when the diff is too large to be worth one', () => {
    const stages = createDefaultStages({ ...config, verifyMaxPartitions: 1 });
    const verify = stages.at(-1) as ReviewStage;
    const context = { packets: [{}, {}] } as never;
    expect(verify.shouldRun(context, [])).toBe(false);
  });

  it('can be turned off entirely', async () => {
    const execute = vi.fn(() => ({ status: 0, stdout: clean, stderr: '' }));
    await reviewDiffDetailed(diff, {
      config: { ...config, verifyEnabled: false },
      execute: execute as never,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('merges findings from every stage and derives one verdict', async () => {
    const staticFinding = {
      severity: 'major' as const,
      category: 'security' as const,
      file: 'auth.ts',
      line: 1,
      detail: 'Detected by a deterministic check.',
    };
    const fakeStatic: ReviewStage = {
      name: 'fake-static',
      costClass: 'free',
      shouldRun: () => true,
      run: () =>
        Promise.resolve({
          stage: 'fake-static',
          status: 'ran' as const,
          findings: [staticFinding],
          notes: ['Static check fired.'],
          durationMs: 0,
        }),
    };

    const { review } = await reviewDiffDetailed(diff, { stages: [fakeStatic] });
    expect(review.risk).toBe('medium');
    expect(review.blocked).toBe(true);
    expect(review.rationale).toBe('Static check fired.');
  });
});

describe('finding merge', () => {
  const at = (
    severity: 'blocker' | 'major' | 'minor',
    line: number,
    detail = 'detail',
    category: 'security' | 'correctness' = 'security',
  ) => ({ severity, category, file: 'a.ts', line, detail });

  it('deduplicates identical findings and orders them worst first', () => {
    const merged = mergeFindings([at('minor', 9), at('blocker', 2), at('minor', 9)]);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.severity).toBe('blocker');
  });

  it('treats one location flagged by two stages as one defect at the worse severity', () => {
    const merged = mergeFindings([
      at('minor', 5, 'The model described it this way.'),
      at('major', 5, 'The static check described it that way.'),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe('major');
    expect(merged[0]?.detail).toContain('The static check described it that way.');
    expect(merged[0]?.detail).toContain('Another independent check reported this same location.');
  });

  it('keeps separate categories at one line apart', () => {
    const merged = mergeFindings([at('major', 5), at('minor', 5, 'other', 'correctness')]);
    expect(merged).toHaveLength(2);
  });

  it('does not add a corroboration note to a single report', () => {
    const merged = mergeFindings([at('major', 5)]);
    expect(merged[0]?.detail).toBe('detail');
  });
});
