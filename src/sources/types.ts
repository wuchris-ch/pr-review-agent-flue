import type { DiffInput } from '../core/input.js';

/**
 * Where a diff comes from.
 *
 * Fetching a pull request used to be implemented twice by unrelated code:
 * once over the `gh` CLI for the one-shot command and once over the REST
 * API for the watcher. Both are now adapters behind this interface, so a
 * new input needs one small module and no changes to the pipeline.
 */
export interface DiffSource {
  readonly name: string;
  fetch(): Promise<ReviewRequest>;
}

export interface ReviewRequest {
  readonly diff: DiffInput;
  /** Repository review guidance, treated as untrusted context. */
  readonly instructions?: string;
  /** Human-readable description of what was reviewed, for logs. */
  readonly label: string;
}
