import { type AgentExecutor, type AgentProcess, runModelChild } from '../agents/executor.js';
import { mapConcurrent } from '../core/concurrency.js';
import type { EvidencePacket } from '../core/diff/types.js';
import { DigestValidationError, groundReview } from '../core/grounding.js';
import { diffSha256 } from '../core/input.js';
import type { Finding } from '../core/schema.js';
import {
  buildReviewMessage,
  FORMAT_RETRY_INSTRUCTION,
  type MessageOptions,
} from './review-message.js';
import type { ReviewContext, ReviewStage, StageAttempt, StageResult } from './types.js';

export const DEFAULT_PARTITION_TIMEOUT_MS = 120_000;
export const DEFAULT_CONCURRENCY = 4;
/** Attempts per partition: one review plus one format/evidence correction. */
export const ATTEMPTS_PER_PARTITION = 2;
/**
 * Tries per attempt when the child itself fails.
 *
 * The gateway intermittently stalls until the child's internal deadline, so
 * a transient execution failure is retried with a fresh child. This is
 * separate from the format correction: bad output gets one corrective
 * prompt, a dead child gets the same prompt again.
 */
export const EXECUTION_TRIES = 2;
const EXECUTION_BACKOFF_MS = 1_000;
/** The child's exit code for a failure no retry can fix. */
const EXIT_REJECTED = 2;

export interface ModelStageOptions {
  name?: string;
  /** Overrides the default task framing, used by specialised stages. */
  task?: string;
  execute?: AgentExecutor;
  concurrency?: number;
  partitionTimeoutMs?: number;
  /**
   * When true, a failure is recorded and the review continues without this
   * stage. Use for stages whose absence is reported rather than fatal.
   */
  optional?: boolean;
  /**
   * Replaces the stage's own summary when it finds nothing. A confirming
   * pass should say that it confirmed, not restate the first pass.
   */
  noteWhenEmpty?: string;
  shouldRun?: (context: ReviewContext, prior: readonly StageResult[]) => boolean;
  /** Restricts the stage to a subset of the review's partitions. */
  selectPackets?: (context: ReviewContext) => readonly EvidencePacket[];
}

interface PartitionOutcome {
  findings: readonly Finding[];
  rationale: string;
}

class PartitionError extends Error {}

function failed(result: { error?: Error; status: number | null }): boolean {
  return Boolean(result.error) || result.status !== 0;
}

function retryable(result: { error?: Error; status: number | null }): boolean {
  return result.status !== EXIT_REJECTED;
}

function describeFailure(result: { error?: Error; status: number | null }): string {
  if (!retryable(result)) {
    return 'review agent could not reach a usable model gateway';
  }
  return result.error
    ? 'review agent could not start or exceeded execution limits'
    : `review agent failed with exit ${String(result.status)}`;
}

interface ExecutionOptions {
  execute: AgentExecutor;
  partitionTimeoutMs: number;
  deadline: ReviewContext['deadline'];
  onFailure: (result: AgentProcess, startedAt: number) => void;
}

/**
 * Run one prompt, retrying a fresh child after a transient failure.
 *
 * A dead child and bad output are different problems: this handles the
 * first, and the caller's format-correction loop handles the second.
 */
async function executeWithRetries(
  message: string,
  options: ExecutionOptions,
): Promise<{ result: AgentProcess; startedAt: number }> {
  for (let attemptTry = 0; attemptTry < EXECUTION_TRIES; attemptTry += 1) {
    const budget = options.deadline.child(options.partitionTimeoutMs);
    if (budget.expired()) {
      throw new PartitionError('review exhausted its overall time budget');
    }

    const startedAt = Date.now();
    const result = await options.execute(message, budget.remainingMs());
    if (!failed(result)) {
      return { result, startedAt };
    }

    options.onFailure(result, startedAt);
    const lastTry = attemptTry === EXECUTION_TRIES - 1;
    if (lastTry || !retryable(result) || options.deadline.expired()) {
      throw new PartitionError(describeFailure(result));
    }
    await new Promise((resolve) => setTimeout(resolve, EXECUTION_BACKOFF_MS * (attemptTry + 1)));
  }

  throw new PartitionError('review agent produced no result');
}

async function reviewPartition(
  context: ReviewContext,
  packet: EvidencePacket,
  position: { index: number; total: number },
  stage: string,
  options: Required<Pick<ModelStageOptions, 'execute' | 'partitionTimeoutMs'>> & { task?: string },
): Promise<PartitionOutcome> {
  const message = buildReviewMessage(context.diff, {
    ...(context.feedback === undefined ? {} : { feedback: context.feedback }),
    ...(context.instructions === undefined ? {} : { instructions: context.instructions }),
    ...(options.task === undefined ? {} : { task: options.task }),
    partition: { index: position.index, total: position.total, text: packet.text },
  } satisfies MessageOptions);

  for (let attempt = 0; attempt < ATTEMPTS_PER_PARTITION; attempt += 1) {
    const attemptMessage = attempt === 0 ? message : `${message}${FORMAT_RETRY_INSTRUCTION}`;
    const record = (outcome: StageAttempt['outcome'], output: string, startedAt: number): void => {
      context.onAttempt?.({
        stage,
        partition: position.index,
        attempt: attempt + 1,
        outcome,
        latencyMs: Date.now() - startedAt,
        messageBytes: Buffer.byteLength(attemptMessage),
        outputSha256: diffSha256(Buffer.from(output)),
        retrievedHunks: packet.retrievedHunks,
      });
    };

    const { result, startedAt } = await executeWithRetries(attemptMessage, {
      execute: options.execute,
      partitionTimeoutMs: options.partitionTimeoutMs,
      deadline: context.deadline,
      onFailure: (failure, failedAt) => record('execution', failure.stdout, failedAt),
    });

    try {
      const review = groundReview(result.stdout, packet, context.diff.sha256);
      record('accepted', result.stdout, startedAt);
      return { findings: review.findings, rationale: review.rationale.trim() };
    } catch (error) {
      if (error instanceof DigestValidationError) {
        record('digest', result.stdout, startedAt);
        throw error;
      }
      record('invalid', result.stdout, startedAt);
    }
  }

  throw new PartitionError('model output is invalid after one format/evidence correction');
}

/**
 * Build a stage that reviews diff partitions with the model.
 *
 * Partitions run through a bounded worker pool and each gets its own
 * deadline derived from the review deadline, so adding partitions costs
 * throughput rather than making the review impossible to finish.
 */
export function createModelStage(options: ModelStageOptions = {}): ReviewStage {
  const name = options.name ?? 'model-review';
  const execute = options.execute ?? runModelChild;
  const partitionTimeoutMs = options.partitionTimeoutMs ?? DEFAULT_PARTITION_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  return {
    name,
    costClass: 'model',
    shouldRun: (context, prior) => options.shouldRun?.(context, prior) ?? true,
    async run(context) {
      const startedAt = Date.now();
      const packets = options.selectPackets?.(context) ?? context.packets;
      try {
        const outcomes = await mapConcurrent(packets, concurrency, (packet, index) =>
          reviewPartition(context, packet, { index: index + 1, total: packets.length }, name, {
            execute,
            partitionTimeoutMs,
            ...(options.task === undefined ? {} : { task: options.task }),
          }),
        );

        const findings = outcomes.flatMap((outcome) => [...outcome.findings]);
        const summaries = [
          ...new Set(outcomes.map((outcome) => outcome.rationale).filter(Boolean)),
        ];
        return {
          stage: name,
          status: 'ran',
          findings,
          notes:
            findings.length === 0 && options.noteWhenEmpty ? [options.noteWhenEmpty] : summaries,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (!options.optional) {
          throw error;
        }
        // Say so in the verdict. A reader must never mistake "the extra
        // check could not run" for "the extra check found nothing".
        return {
          stage: name,
          status: 'failed',
          findings: [],
          notes: [`The ${name} stage did not complete, so its checks are not reflected here.`],
          durationMs: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
