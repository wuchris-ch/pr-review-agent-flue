import type { AgentExecutor } from './agents/executor.js';
import { type ReviewConfig, reviewConfig } from './core/config.js';
import { Deadline } from './core/deadline.js';
import { evidencePackets } from './core/diff/packets.js';
import { indexDiff } from './core/diff/parse.js';
import { type DiffInput, diffSha256 } from './core/input.js';
import type { Review } from './core/schema.js';
import { createModelStage } from './stages/model-stage.js';
import { type PipelineResult, runPipeline } from './stages/pipeline.js';
import { availableDiffBytes } from './stages/review-message.js';
import { createStaticStage } from './stages/static-stage.js';
import {
  collectFindings,
  type ReviewContext,
  type ReviewStage,
  type StageAttempt,
} from './stages/types.js';

export interface ReviewOptions {
  instructions?: string;
  feedback?: string;
  /** Replaces the default stage set. Used by tests and specialised callers. */
  stages?: readonly ReviewStage[];
  /** Replaces the model transport. Used by tests and the eval harness. */
  execute?: AgentExecutor;
  config?: Partial<ReviewConfig>;
  onAttempt?: (attempt: StageAttempt) => void;
}

const VERIFY_TASK = [
  'A first reviewer found no blocking defect in this unified diff. Independently re-examine it.',
  'Concentrate on changed failure paths: removed guards, widened catch blocks, fallback returns,',
  'and what the shown callers do with those values. Report a finding only when the supplied source',
  'demonstrates it. Returning an empty findings array is the correct answer for a sound diff.',
].join(' ');

/**
 * The gated second opinion.
 *
 * A missed defect is the expensive error for a security reviewer, so a clean
 * verdict on a small diff is worth one more pass. The gate keeps that cost
 * bounded: it never runs when something was already found, and never on a
 * diff large enough for the second pass to dominate the review.
 */
function verifyGate(config: ReviewConfig) {
  return (
    context: ReviewContext,
    prior: readonly import('./stages/types.js').StageResult[],
  ): boolean => {
    if (!config.verifyEnabled || context.packets.length > config.verifyMaxPartitions) {
      return false;
    }
    return collectFindings(prior).every(
      (finding) => finding.severity !== 'blocker' && finding.severity !== 'major',
    );
  };
}

export function createDefaultStages(config: ReviewConfig, execute?: AgentExecutor): ReviewStage[] {
  const shared = {
    concurrency: config.concurrency,
    partitionTimeoutMs: config.partitionTimeoutMs,
    ...(execute ? { execute } : {}),
  };
  return [
    createStaticStage(),
    createModelStage({ name: 'model-review', ...shared }),
    createModelStage({
      name: 'model-verify',
      task: VERIFY_TASK,
      noteWhenEmpty: 'A second independent pass over the same diff found no additional defects.',
      // Optional by contract: the review still stands without it, and the
      // rationale says when it did not run.
      optional: true,
      shouldRun: verifyGate(config),
      ...shared,
    }),
  ];
}

export function buildReviewContext(diff: DiffInput, options: ReviewOptions = {}): ReviewContext {
  const expected = diffSha256(diff.bytes);
  if (diff.sha256 !== expected) {
    throw new Error('diff input SHA-256 does not match its exact bytes');
  }

  const config = { ...reviewConfig(), ...options.config };
  const feedback = options.feedback ?? process.env.AGENT_EVAL_FEEDBACK;
  const framing = {
    ...(feedback === undefined ? {} : { feedback }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  };
  // Two budgets: the ceiling the transport accepts, and the smaller size the
  // model answers reliably at. The packer prefers the second and uses the
  // first only for a file too large to fit it.
  const budget = availableDiffBytes(diff, framing);
  const target = availableDiffBytes(diff, framing, config.partitionBytes);

  return {
    diff,
    packets: evidencePackets(indexDiff(diff.text), budget, target),
    deadline: Deadline.in(config.deadlineMs),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
  };
}

/** Review a diff and return the full pipeline record, including per-stage results. */
export async function reviewDiffDetailed(
  diff: DiffInput,
  options: ReviewOptions = {},
): Promise<PipelineResult> {
  const config = { ...reviewConfig(), ...options.config };
  const context = buildReviewContext(diff, options);
  const stages = options.stages ?? createDefaultStages(config, options.execute);
  return runPipeline(context, stages);
}

/** Review a diff and return the verdict. */
export async function reviewDiff(diff: DiffInput, options: ReviewOptions = {}): Promise<Review> {
  const { review } = await reviewDiffDetailed(diff, options);
  return review;
}
