import { reviewConfig } from '../core/config.js';
import type { DiffInput } from '../core/input.js';
import type { Review } from '../core/schema.js';
import { type ReviewOptions, reviewDiffDetailed } from '../review-service.js';
import { RunRecorder } from './run-log.js';

export interface RunMeta {
  /** What was reviewed, for example a pull request reference or a diff path. */
  label: string;
  /** Which entry point asked for the review. */
  source: string;
}

/**
 * Review a diff and record the run.
 *
 * Every entry point goes through here so telemetry is not something the
 * production watcher can quietly skip while the one-shot commands have it.
 */
export async function reviewAndRecord(
  diff: DiffInput,
  meta: RunMeta,
  options: ReviewOptions = {},
): Promise<Review> {
  const recorder = new RunRecorder(
    { ...meta, model: process.env.REVIEW_AGENT_MODEL },
    reviewConfig().runLogDir,
  );

  try {
    const { review, stages, partitions } = await reviewDiffDetailed(diff, {
      ...options,
      onAttempt: recorder.onAttempt,
    });
    recorder.complete(review, stages, partitions);
    return review;
  } catch (error) {
    recorder.fail(error);
    throw error;
  }
}
