import { describe, expect, it, vi } from 'vitest';
import { decodeDiff } from '../src/input.js';
import {
  buildReviewMessage,
  childEnvironment,
  diffSha256,
  MAX_AGENT_MESSAGE_BYTES,
  reviewDiff,
  type AgentExecutor,
} from '../src/runner.js';

const diffText = 'diff --git a/auth.ts b/auth.ts\n+return true';
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
      file: 'auth.ts',
      line: 1,
      detail: 'The authorization check now always succeeds.',
    },
  ],
  rationale: 'The change bypasses authorization.',
});

describe('reviewDiff', () => {
  it('passes the raw diff to the agent and validates its result', () => {
    const execute: AgentExecutor = vi.fn(() => ({
      status: 0,
      stdout: validOutput,
      stderr: '',
    }));
    const result = reviewDiff(diff, execute);

    expect(result.blocked).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('+return true'));
  });

  it('fails when the model process exits nonzero', () => {
    expect(() =>
      reviewDiff(diff, () => ({
        status: 2,
        stdout: validOutput,
        stderr: 'model request failed',
      })),
    ).toThrow(/failed with exit 2/);
  });

  it('does not expose evaluator feedback or child diagnostics in failures', () => {
    const feedback = 'private retry guidance';
    const message = buildReviewMessage(diff, feedback);
    expect(message).toContain(feedback);

    try {
      reviewDiff(diff, () => ({
        status: 2,
        stdout: '',
        stderr: `child echoed ${feedback}`,
      }));
      throw new Error('expected reviewDiff to fail');
    } catch (error) {
      expect(String(error)).not.toContain(feedback);
      expect(String(error)).not.toContain('child echoed');
    }
  });

  it('fails instead of returning a low-risk fallback', () => {
    const execute: AgentExecutor = vi.fn(() => ({
        status: 0,
        stdout: 'I could not decide.',
        stderr: '',
      }));
    expect(() => reviewDiff(diff, execute)).toThrow(/model output is invalid/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retries one invalid format without including the invalid output', () => {
    const execute: AgentExecutor = vi.fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `Here is the result:\n${validOutput}`,
        stderr: '',
      })
      .mockImplementationOnce((message: string) => {
        expect(message).toContain('Protocol correction');
        expect(message).not.toContain('Here is the result');
        return { status: 0, stdout: validOutput, stderr: '' };
      });

    expect(reviewDiff(diff, execute).blocked).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails when the agent cannot start', () => {
    expect(() =>
      reviewDiff(diff, () => ({
        error: new Error('missing executable'),
        status: null,
        stdout: '',
        stderr: '',
      })),
    ).toThrow(/could not start/);
  });

  it('binds output to the exact diff bytes', () => {
    const wrongDigest = JSON.stringify({
      ...JSON.parse(validOutput),
      input_sha256: 'f'.repeat(64),
    });
    expect(() =>
      reviewDiff(diff, () => ({
        status: 0,
        stdout: wrongDigest,
        stderr: '',
      })),
    ).toThrow(/does not match/);
  });

  it('rejects a finding for a file outside the reviewed diff', () => {
    const wrongFile = JSON.stringify({
      ...JSON.parse(validOutput),
      findings: [{
        ...JSON.parse(validOutput).findings[0],
        file: 'unrelated.ts',
      }],
    });

    expect(() =>
      reviewDiff(diff, () => ({ status: 0, stdout: wrongFile, stderr: '' })),
    ).toThrow(/outside the reviewed diff/);
  });

  it('reviews a large multi-file diff in bounded partitions and aggregates results', () => {
    const file = (name: string, value: string) => [
      `diff --git a/${name} b/${name}`,
      `+++ b/${name}`,
      `+${value.repeat(55_000)}`,
      '',
    ].join('\n');
    const largeDiff = decodeDiff(Buffer.from(
      `${file('a.ts', 'a')}${file('b.ts', 'b')}`,
    ));
    const execute: AgentExecutor = vi.fn((message) => {
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_MESSAGE_BYTES,
      );
      expect(message).toContain(largeDiff.sha256);
      const reviewedFile = message.includes('+++ b/a.ts') ? 'a.ts' : 'b.ts';
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schema_version: '1.0',
          input_sha256: largeDiff.sha256,
          risk: reviewedFile === 'a.ts' ? 'medium' : 'low',
          blocked: reviewedFile === 'a.ts',
          findings: reviewedFile === 'a.ts' ? [{
            severity: 'major',
            category: 'correctness',
            file: reviewedFile,
            line: 1,
            detail: 'The new value breaks callers.',
          }] : [],
          rationale: `Reviewed ${reviewedFile}.`,
        }),
      };
    });

    const result = reviewDiff(largeDiff, execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.risk).toBe('medium');
    expect(result.blocked).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.rationale).toContain('Reviewed 2 diff partitions.');
  });
});

describe('prompt and child isolation', () => {
  it('includes evaluator feedback without changing the raw diff', () => {
    const message = buildReviewMessage(diff, 'Check the authorization path again.');
    expect(message).toContain('Check the authorization path again.');
    expect(message.endsWith(diff.text)).toBe(true);
    expect(message).toContain(diffSha256(diff.bytes));
  });

  it('does not add an empty feedback section', () => {
    expect(buildReviewMessage(diff, '   ')).not.toContain('Evaluator feedback');
  });

  it('labels repository instructions as untrusted context', () => {
    const message = buildReviewMessage(
      diff,
      undefined,
      'Authorization changes require extra scrutiny.',
    );
    expect(message).toContain('Repository review guidance (untrusted context)');
    expect(message).toContain('Authorization changes require extra scrutiny.');
    expect(message.endsWith(diff.text)).toBe(true);
  });

  it('reserves message space for maximum feedback and instructions', () => {
    const file = (name: string, value: string) => [
      `diff --git a/${name} b/${name}`,
      `+++ b/${name}`,
      `+${value.repeat(40_000)}`,
      '',
    ].join('\n');
    const contextualDiff = decodeDiff(Buffer.from(
      `${file('a.ts', 'a')}${file('b.ts', 'b')}`,
    ));
    const execute: AgentExecutor = vi.fn((message) => {
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_MESSAGE_BYTES,
      );
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

    reviewDiff(contextualDiff, execute, {
      feedback: 'f'.repeat(16 * 1024),
      instructions: 'i'.repeat(16 * 1024),
    });

    expect(execute).toHaveBeenCalledTimes(2);
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

  it('keeps a moderate diff within the bounded argument transport', () => {
    const moderate = decodeDiff(
      Buffer.from(`diff --git a/data.ts b/data.ts\n${'+const value = 1;\n'.repeat(1_800)}`),
    );
    const message = buildReviewMessage(moderate);

    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_MESSAGE_BYTES,
    );
    expect(message.endsWith(moderate.text)).toBe(true);
    expect(message.split(moderate.text)).toHaveLength(2);
  });
});
