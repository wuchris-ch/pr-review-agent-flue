import { retrieveContext } from '../context/repository.js';
import { DEFAULT_REPOSITORY_CONFIG } from '../core/repository-config.js';
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
  const configuration = request.configuration ?? DEFAULT_REPOSITORY_CONFIG;
  const repositoryContext =
    request.repository && configuration.context
      ? await retrieveContext(request.diff.text, request.repository, configuration)
      : undefined;
  const instructions = [request.instructions, ...configuration.rules].filter(Boolean).join('\n\n');
  return reviewAndRecord(
    request.diff,
    { label: request.label, source: source.name },
    {
      instructions,
      repositoryConfig: configuration,
      ...(repositoryContext ? { repositoryContext } : {}),
    },
  );
}
