import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Review } from '../core/schema.js';
import type { StageAttempt, StageResult } from '../stages/types.js';

export const RUN_RECORD_VERSION = 1;

export interface RunRecord {
  readonly version: number;
  readonly run_id: string;
  readonly started_at: string;
  readonly duration_ms: number;
  /** What was reviewed, for example a PR reference or a diff path. */
  readonly label: string;
  readonly source: string;
  readonly input_sha256: string;
  readonly model: string | undefined;
  readonly partitions: number;
  readonly outcome: 'completed' | 'failed';
  readonly error?: string;
  readonly review?: Review;
  readonly stages: readonly Omit<StageResult, 'findings' | 'notes'>[];
  readonly attempts: readonly StageAttempt[];
}

/**
 * Records one review per line so a regression can be replayed later.
 *
 * The pipeline already emitted per-attempt telemetry; every caller threw it
 * away. Collecting it here gives the eval harness latency and retry data,
 * and gives an operator a durable answer to "what did the agent see".
 * Review content is sensitive, so records go to a caller-chosen directory
 * and never to a default shared location.
 */
export class RunRecorder {
  private readonly attempts: StageAttempt[] = [];
  private readonly startedAt = Date.now();
  private readonly startedIso = new Date().toISOString();
  readonly runId = randomUUID();

  constructor(
    private readonly meta: { label: string; source: string; model?: string | undefined },
    private readonly directory?: string | undefined,
  ) {}

  /** Pass as the pipeline's `onAttempt` callback. */
  readonly onAttempt = (attempt: StageAttempt): void => {
    this.attempts.push(attempt);
  };

  complete(review: Review, stages: readonly StageResult[], partitions: number): RunRecord {
    return this.write({
      outcome: 'completed',
      review,
      partitions,
      stages: stages.map(({ findings: _f, notes: _n, ...rest }) => rest),
    });
  }

  fail(error: unknown, partitions = 0): RunRecord {
    return this.write({
      outcome: 'failed',
      partitions,
      stages: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private write(
    part: Pick<RunRecord, 'outcome' | 'partitions' | 'stages'> &
      Partial<Pick<RunRecord, 'review' | 'error'>>,
  ): RunRecord {
    const record: RunRecord = {
      version: RUN_RECORD_VERSION,
      run_id: this.runId,
      started_at: this.startedIso,
      duration_ms: Date.now() - this.startedAt,
      label: this.meta.label,
      source: this.meta.source,
      input_sha256: part.review?.input_sha256 ?? '',
      model: this.meta.model,
      attempts: this.attempts,
      ...part,
    };

    if (this.directory) {
      try {
        mkdirSync(this.directory, { recursive: true });
        appendFileSync(join(this.directory, 'runs.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
      } catch {
        // A run log is diagnostic. Losing it must never fail a review.
      }
    }
    return record;
  }
}
