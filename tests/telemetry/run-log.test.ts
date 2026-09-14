import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Review } from '../../src/core/schema.js';
import { RunRecorder } from '../../src/telemetry/run-log.js';

const review: Review = {
  schema_version: '1.0',
  input_sha256: 'a'.repeat(64),
  risk: 'low',
  blocked: false,
  findings: [],
  rationale: 'No actionable defects found.',
};

const attempt = {
  stage: 'model-review',
  partition: 1,
  attempt: 1,
  outcome: 'accepted' as const,
  latencyMs: 120,
  messageBytes: 2048,
  outputSha256: 'b'.repeat(64),
  retrievedHunks: 2,
};

describe('run recorder', () => {
  it('captures the attempt telemetry the pipeline emits', () => {
    const recorder = new RunRecorder({ label: 'owner/repo#1', source: 'gh' });
    recorder.onAttempt(attempt);
    const record = recorder.complete(review, [], 1);

    expect(record.attempts).toEqual([attempt]);
    expect(record.outcome).toBe('completed');
    expect(record.input_sha256).toBe(review.input_sha256);
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('appends one JSON line per run when a directory is configured', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pr-review-runs-'));
    const first = new RunRecorder({ label: 'a', source: 'local' }, directory);
    first.complete(review, [], 1);
    new RunRecorder({ label: 'b', source: 'local' }, directory).fail(new Error('boom'));

    const lines = readFileSync(join(directory, 'runs.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ outcome: 'failed', error: 'boom' });
  });

  it('keeps a review working when the log cannot be written', () => {
    const recorder = new RunRecorder({ label: 'a', source: 'local' }, '/dev/null/nope');
    expect(() => recorder.complete(review, [], 1)).not.toThrow();
  });

  it('stores no records anywhere by default', () => {
    const record = new RunRecorder({ label: 'a', source: 'local' }).complete(review, [], 1);
    expect(record.run_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
