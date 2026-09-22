import type { Deadline } from '../core/deadline.js';
import type { EvidencePacket } from '../core/diff/types.js';
import type { DiffInput } from '../core/input.js';
import type { Finding } from '../core/schema.js';

/** Everything a stage may read. Stages never reach outside this object. */
export interface ReviewContext {
  readonly diff: DiffInput;
  readonly packets: readonly EvidencePacket[];
  readonly deadline: Deadline;
  readonly instructions?: string;
  readonly feedback?: string;
  readonly onAttempt?: (attempt: StageAttempt) => void;
}

/** One model round trip, emitted for telemetry whether or not it succeeded. */
export interface StageAttempt {
  usage?: { inputTokens: number; outputTokens: number };
  stage: string;
  partition: number;
  attempt: number;
  outcome: 'accepted' | 'invalid' | 'digest' | 'execution';
  latencyMs: number;
  messageBytes: number;
  outputSha256: string;
  retrievedHunks: number;
}

export interface StageResult {
  readonly stage: string;
  readonly status: 'ran' | 'skipped' | 'failed';
  readonly findings: readonly Finding[];
  /** Rationale fragments merged into the final review summary. */
  readonly notes: readonly string[];
  readonly durationMs: number;
  /** Why the stage was skipped or how it failed. */
  readonly reason?: string;
  /** A successful validation stage replaces draft model findings, never static checks. */
  readonly replaces?: readonly string[];
}

/**
 * A unit of review work.
 *
 * Cheap deterministic checks and model calls implement the same interface,
 * so the pipeline can order them by cost and let later stages gate on what
 * earlier ones found.
 */
export interface ReviewStage {
  readonly name: string;
  /** `free` stages cost no tokens and always run; `model` stages may be gated. */
  readonly costClass: 'free' | 'model';
  readonly required?: boolean;
  shouldRun(context: ReviewContext, prior: readonly StageResult[]): boolean;
  run(context: ReviewContext, prior: readonly StageResult[]): Promise<StageResult>;
}

export function skipped(stage: string, reason: string): StageResult {
  return { stage, status: 'skipped', findings: [], notes: [], durationMs: 0, reason };
}

/** Every finding produced so far, across stages that actually ran. */
export function collectFindings(results: readonly StageResult[]): Finding[] {
  const replaced = new Set(
    results.filter((result) => result.status === 'ran').flatMap((result) => result.replaces ?? []),
  );
  return results
    .filter((result) => !replaced.has(result.stage))
    .flatMap((result) => [...result.findings]);
}
