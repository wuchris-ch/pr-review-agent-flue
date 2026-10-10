import { AGENT_CLIS, type AgentCli } from '../agents/agent-reviewer.js';

/**
 * Every environment variable the review pipeline reads, in one place.
 *
 * Defaults are chosen so the overall deadline can actually accommodate the
 * maximum partition count at the configured concurrency, which the previous
 * single 120s budget could not.
 */

export interface ReviewConfig {
  /** Partitions reviewed at once. Bounds concurrent model child processes. */
  concurrency: number;
  /** Preferred bytes per agent message, below the hard protocol ceiling. */
  partitionBytes: number;
  /** Per-partition wall clock, including its format correction attempt. */
  partitionTimeoutMs: number;
  /** Wall clock for the whole review across every stage. */
  deadlineMs: number;
  /** Run the gated second-opinion stage on clean reviews of small diffs. */
  verifyEnabled: boolean;
  /** Largest diff, in partitions, worth a second opinion. */
  verifyMaxPartitions: number;
  /** Run the focused defect-hunting passes beside the main review. */
  huntEnabled: boolean;
  /** Which focused hunts run when hunting is enabled. */
  huntFocus: readonly HuntFocus[];
  /** Upper bound on repository context added to each partition. */
  contextBytes: number;
  /** Let the model search and read head-revision source before reviewing. */
  exploreEnabled: boolean;
  /** Exploration round trips, each with several lookups. */
  exploreRounds: number;
  /** Extra context room per partition for explored excerpts. */
  exploreContextBytes: number;
  /** Coding-agent CLI that explores a local checkout and proposes findings, or undefined. */
  agentCli?: AgentCli;
  /** Model the agent CLI should use; its own default when undefined. */
  agentModel?: string;
  /** Reasoning effort passed to the agent CLI. */
  agentEffort: string;
  /** Wall clock for one agent review. */
  agentTimeoutMs: number;
  /** Run evidence validation over the agent's grounded findings. */
  agentValidate: boolean;
  /** Lines a proposal may sit from the changed line it is tied to. */
  agentLineTolerance: number;
  /** Directory for JSONL run records, or undefined to keep them in memory. */
  runLogDir?: string;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (['1', 'on', 'true', 'yes'].includes(raw)) {
    return true;
  }
  if (['0', 'off', 'false', 'no'].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be on or off`);
}

export type HuntFocus = 'logic' | 'state' | 'contracts';
const HUNT_FOCI: readonly HuntFocus[] = ['logic', 'state', 'contracts'];

function huntFocus(env: NodeJS.ProcessEnv): readonly HuntFocus[] {
  const raw = env.REVIEW_HUNT_FOCUS?.trim();
  if (!raw) return HUNT_FOCI;
  const selected = raw.split(',').map((value) => value.trim());
  if (!selected.every((value): value is HuntFocus => HUNT_FOCI.includes(value as HuntFocus)))
    throw new Error('REVIEW_HUNT_FOCUS must list logic, state or contracts');
  return [...new Set(selected as HuntFocus[])];
}

export function reviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const runLogDir = env.REVIEW_RUN_LOG_DIR?.trim();
  const agentCli = env.REVIEW_AGENT_CLI?.trim();
  if (agentCli && !AGENT_CLIS.includes(agentCli as AgentCli))
    throw new Error('REVIEW_AGENT_CLI must be claude or codex');
  const agentModel = env.REVIEW_AGENT_CLI_MODEL?.trim();
  return {
    concurrency: integer(env, 'REVIEW_CONCURRENCY', 6, 1, 12),
    partitionBytes: integer(env, 'REVIEW_PARTITION_KIB', 48, 8, 96) * 1024,
    partitionTimeoutMs: integer(env, 'REVIEW_PARTITION_TIMEOUT_SECONDS', 210, 15, 600) * 1000,
    deadlineMs: integer(env, 'REVIEW_DEADLINE_SECONDS', 900, 30, 3600) * 1000,
    verifyEnabled: flag(env, 'REVIEW_VERIFY_STAGE', true),
    verifyMaxPartitions: integer(env, 'REVIEW_VERIFY_MAX_PARTITIONS', 4, 1, 24),
    // Off by default: on the development split the hunts doubled false positives.
    huntEnabled: flag(env, 'REVIEW_HUNT_STAGES', false),
    huntFocus: huntFocus(env),
    // Whole changed files plus related excerpts; 40 KiB raised development F1 from 22% to 30%.
    contextBytes: integer(env, 'REVIEW_CONTEXT_KIB', 40, 4, 64) * 1024,
    exploreEnabled: flag(env, 'REVIEW_EXPLORE', false),
    // Bounded so the last round's diff plus earlier results stay under the 128 KiB child input.
    exploreRounds: integer(env, 'REVIEW_EXPLORE_ROUNDS', 3, 1, 4),
    exploreContextBytes: integer(env, 'REVIEW_EXPLORE_CONTEXT_KIB', 24, 4, 48) * 1024,
    ...(agentCli ? { agentCli: agentCli as AgentCli } : {}),
    ...(agentModel ? { agentModel } : {}),
    agentEffort: env.REVIEW_AGENT_CLI_EFFORT?.trim() || 'high',
    agentTimeoutMs: integer(env, 'REVIEW_AGENT_CLI_TIMEOUT_SECONDS', 1200, 60, 3600) * 1000,
    agentValidate: flag(env, 'REVIEW_AGENT_VALIDATE', false),
    // Exact changed lines: on the development split this kept the same F1 as the
    // agent's own locations while removing a third of its unsupported comments.
    agentLineTolerance: integer(env, 'REVIEW_AGENT_LINE_TOLERANCE', 0, 0, 50),
    ...(runLogDir ? { runLogDir } : {}),
  };
}
