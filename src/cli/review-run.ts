import type { Review } from '../core/schema.js';
import type { DiffSource } from '../sources/types.js';
import { reviewAndRecord } from '../telemetry/recorded-review.js';

/**
 * Fetch a diff from a source, review it, and record the run.
 *
 * Every command shares this path so configuration, telemetry, and error
 * behaviour cannot diverge between the local, pull-request, and raw-diff
 * entry points.
 */
export async function reviewFromSource(source: DiffSource): Promise<Review> {
  const request = await source.fetch();
  return reviewAndRecord(
    request.diff,
    { label: request.label, source: source.name },
    request.instructions === undefined ? {} : { instructions: request.instructions },
  );
}
