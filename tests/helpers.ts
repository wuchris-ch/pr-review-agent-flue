import type { AgentProcess } from '../src/agents/executor.js';
import type { Review } from '../src/core/schema.js';
import { createModelStage } from '../src/stages/model-stage.js';
import type { ReviewStage } from '../src/stages/types.js';

/** A stubbed model call. Tests may return the process record synchronously. */
export type StubExecutor = (
  message: string,
  timeoutMs?: number,
) => AgentProcess | Promise<AgentProcess>;

/**
 * A pipeline containing only the model stage.
 *
 * Most tests exercise model behaviour, so they opt out of the static and
 * verification stages rather than stubbing extra calls.
 */
export function modelOnly(execute: StubExecutor, concurrency = 1): ReviewStage[] {
  return [createModelStage({ execute: execute as never, concurrency })];
}

export function okProcess(stdout: string): AgentProcess {
  return { status: 0, stdout, stderr: '' };
}

export const cleanReview = (digest: string): Review => ({
  schema_version: '1.0',
  input_sha256: digest,
  risk: 'low',
  blocked: false,
  findings: [],
  rationale: 'No actionable defects found.',
});
