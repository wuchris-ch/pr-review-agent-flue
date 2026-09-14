import { describe, expect, it, vi } from 'vitest';
import { childEnvironment } from '../../src/agents/executor.js';
import { decodeDiff, diffSha256 } from '../../src/core/input.js';
import { reviewDiff } from '../../src/review-service.js';
import { buildReviewMessage, MAX_AGENT_MESSAGE_BYTES } from '../../src/stages/review-message.js';
import { modelOnly } from '../helpers.js';

const diffText =
  'diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-return false\n+return true\n';
const diff = decodeDiff(Buffer.from(diffText));

const validOutput = JSON.stringify({
  schema_version: '1.0',
  input_sha256: diffSha256(diff.bytes),
  risk: 'high',
  blocked: true,
  findings: [
    {
      severity: 'blocker',
      category: 'security',
      evidence: { anchor: 'F1N1', quote: 'return true' },
      detail: 'The authorization check now always succeeds.',
    },
  ],
  rationale: 'The change bypasses authorization.',
});

describe('model review stage', () => {
  it('passes anchored diff text to the agent and validates its result', async () => {
    const execute = vi.fn(() => ({ status: 0, stdout: validOutput, stderr: '' }));
    const review = await reviewDiff(diff, { stages: modelOnly(execute) });

    expect(review.blocked).toBe(true);
    expect(execute.mock.calls[0]?.[0]).toContain('+ [F1N1] return true');
  });

  it('fails when the model process exits nonzero', async () => {
    await expect(
      reviewDiff(diff, {
        stages: modelOnly(() => ({
          status: 3,
          stdout: validOutput,
          stderr: 'model request failed',
        })),
      }),
    ).rejects.toThrow(/failed with exit 3/);
  });

  it('does not expose evaluator feedback or child diagnostics in failures', async () => {
    const feedback = 'private retry guidance';
    expect(buildReviewMessage(diff, { feedback })).toContain(feedback);

    await expect(
      reviewDiff(diff, {
        stages: modelOnly(() => ({
          status: 2,
          stdout: '',
          stderr: `child echoed ${feedback}`,
        })),
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(feedback) as unknown as string,
      }),
    );
  });

  it('fails instead of returning a low-risk fallback', async () => {
    const execute = vi.fn(() => ({ status: 0, stdout: 'I could not decide.', stderr: '' }));
    await expect(reviewDiff(diff, { stages: modelOnly(execute) })).rejects.toThrow(
      /invalid after one format/,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retries one invalid format without including the invalid output', async () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: `Here is the result:\n${validOutput}`, stderr: '' })
      .mockImplementationOnce((message: string) => {
        expect(message).toContain('Protocol correction');
        expect(message).not.toContain('Here is the result');
        return { status: 0, stdout: validOutput, stderr: '' };
      });

    const review = await reviewDiff(diff, { stages: modelOnly(execute) });
    expect(review.blocked).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails when the agent cannot start', async () => {
    await expect(
      reviewDiff(diff, {
        stages: modelOnly(() => ({
          error: new Error('missing executable'),
          status: null,
          stdout: '',
          stderr: '',
        })),
      }),
    ).rejects.toThrow(/could not start/);
  });

  it('binds output to the exact diff bytes', async () => {
    const wrongDigest = JSON.stringify({
      ...JSON.parse(validOutput),
      input_sha256: 'f'.repeat(64),
    });
    await expect(
      reviewDiff(diff, {
        stages: modelOnly(() => ({ status: 0, stdout: wrongDigest, stderr: '' })),
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects a finding for a file outside the reviewed diff', async () => {
    const wrongFile = JSON.stringify({
      ...JSON.parse(validOutput),
      findings: [
        {
          ...JSON.parse(validOutput).findings[0],
          evidence: { anchor: 'F9N1', quote: 'unrelated' },
        },
      ],
    });

    await expect(
      reviewDiff(diff, { stages: modelOnly(() => ({ status: 0, stdout: wrongFile, stderr: '' })) }),
    ).rejects.toThrow(/invalid after one format\/evidence correction/);
  });
});

describe('partitioned reviews', () => {
  const bigFile = (name: string, value: string, repeat: number) =>
    [
      `diff --git a/${name} b/${name}`,
      '--- /dev/null',
      `+++ b/${name}`,
      '@@ -0,0 +1 @@',
      `+${value.repeat(repeat)}`,
      '',
    ].join('\n');

  it('reviews a large multi-file diff in bounded partitions and merges findings', async () => {
    const largeDiff = decodeDiff(
      Buffer.from(`${bigFile('a.ts', 'a', 55_000)}${bigFile('b.ts', 'b', 55_000)}`),
    );
    const execute = vi.fn((message: string) => {
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_BYTES);
      expect(message).toContain(largeDiff.sha256);
      const reviewed = message.includes('+++ b/a.ts') ? 'a.ts' : 'b.ts';
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schema_version: '1.0',
          input_sha256: largeDiff.sha256,
          risk: reviewed === 'a.ts' ? 'medium' : 'low',
          blocked: reviewed === 'a.ts',
          findings:
            reviewed === 'a.ts'
              ? [
                  {
                    severity: 'major',
                    category: 'correctness',
                    evidence: { anchor: 'F1N1', quote: 'aaa' },
                    detail: 'The new value breaks callers.',
                  },
                ]
              : [],
          rationale: `Reviewed ${reviewed}.`,
        }),
      };
    });

    const review = await reviewDiff(largeDiff, { stages: modelOnly(execute, 4) });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(review.risk).toBe('medium');
    expect(review.blocked).toBe(true);
    expect(review.findings).toHaveLength(1);
    expect(review.rationale).toContain('Reviewed a.ts.');
  });

  it('runs partitions concurrently rather than one after another', async () => {
    const files = Array.from({ length: 8 }, (_, index) =>
      bigFile(`f${String(index)}.ts`, String(index % 10), 50_000),
    ).join('');
    const wide = decodeDiff(Buffer.from(files));

    let inFlight = 0;
    let peak = 0;
    const execute = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schema_version: '1.0',
          input_sha256: wide.sha256,
          risk: 'low',
          blocked: false,
          findings: [],
          rationale: 'No actionable issue was found.',
        }),
      };
    };

    await reviewDiff(wide, { stages: modelOnly(execute, 4) });
    expect(peak).toBe(4);
  });

  it('reserves message space for maximum feedback and instructions', async () => {
    const contextualDiff = decodeDiff(
      Buffer.from(`${bigFile('a.ts', 'a', 40_000)}${bigFile('b.ts', 'b', 40_000)}`),
    );
    const execute = vi.fn((message: string) => {
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_BYTES);
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schema_version: '1.0',
          input_sha256: contextualDiff.sha256,
          risk: 'low',
          blocked: false,
          findings: [],
          rationale: 'No actionable issue was found.',
        }),
      };
    });

    await reviewDiff(contextualDiff, {
      stages: modelOnly(execute, 2),
      feedback: 'f'.repeat(16 * 1024),
      instructions: 'i'.repeat(16 * 1024),
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('prompt construction and child isolation', () => {
  it('includes evaluator feedback without changing the raw diff', () => {
    const message = buildReviewMessage(diff, { feedback: 'Check the authorization path again.' });
    expect(message).toContain('Check the authorization path again.');
    expect(message).toContain('+ [F1N1] return true');
    expect(message).toContain(diffSha256(diff.bytes));
  });

  it('does not add an empty feedback section', () => {
    expect(buildReviewMessage(diff, { feedback: '   ' })).not.toContain('Evaluator feedback');
  });

  it('labels repository instructions as untrusted context', () => {
    const message = buildReviewMessage(diff, {
      instructions: 'Authorization changes require extra scrutiny.',
    });
    expect(message).toContain('Repository review guidance (untrusted context)');
    expect(message).toContain('Authorization changes require extra scrutiny.');
    expect(message).toContain('+ [F1N1] return true');
  });

  it('keeps a moderate diff within the bounded message transport', () => {
    const moderate = decodeDiff(
      Buffer.from(
        `diff --git a/data.ts b/data.ts\n--- /dev/null\n+++ b/data.ts\n@@ -0,0 +1,1800 @@\n${'+const value = 1;\n'.repeat(1_800)}`,
      ),
    );
    const message = buildReviewMessage(moderate);

    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_AGENT_MESSAGE_BYTES);
    expect(message).toContain('+ [F1N1800] const value = 1;');
  });

  it('passes only approved environment variables to the child', () => {
    expect(
      childEnvironment({
        PATH: '/usr/bin',
        MODEL_GATEWAY_API_KEY: 'secret',
        MODEL_GATEWAY_BASE_URL: 'https://gateway.example/v1',
        MODEL_GATEWAY_ADMIN_SECRET: 'must-not-pass',
        REVIEW_AGENT_MODEL: 'model',
        AGENT_EVAL_FEEDBACK: 'retry',
        OTEL_SERVICE_NAME: 'review-agent',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=must-not-pass',
        OTEL_RESOURCE_ATTRIBUTES: 'private.attribute=must-not-pass',
        UNRELATED_SECRET: 'must-not-pass',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      MODEL_GATEWAY_API_KEY: 'secret',
      MODEL_GATEWAY_BASE_URL: 'https://gateway.example/v1',
      REVIEW_AGENT_MODEL: 'model',
      OTEL_SERVICE_NAME: 'review-agent',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });
  });
});
