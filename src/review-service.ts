import { type AgentExecutor, runModelChild } from './agents/executor.js';
import { exploreRepository, withExploredFiles } from './context/explore.js';
import {
  enrichPacket,
  type RepositoryContext,
  type RepositoryReader,
} from './context/repository.js';
import { type ReviewConfig, reviewConfig } from './core/config.js';
import { Deadline } from './core/deadline.js';
import { evidencePackets } from './core/diff/packets.js';
import { indexDiff } from './core/diff/parse.js';
import { type DiffInput, diffSha256 } from './core/input.js';
import {
  DEFAULT_REPOSITORY_CONFIG,
  excluded,
  type RepositoryConfig,
} from './core/repository-config.js';
import type { Review } from './core/schema.js';
import { createModelStage } from './stages/model-stage.js';
import { createParallelStage } from './stages/parallel-stage.js';
import { type PipelineResult, runPipeline } from './stages/pipeline.js';
import { availableDiffBytes } from './stages/review-message.js';
import { createStaticStage } from './stages/static-stage.js';
import {
  collectFindings,
  type ReviewContext,
  type ReviewStage,
  type StageAttempt,
} from './stages/types.js';
import { createFindingValidation } from './stages/validate-findings.js';

export interface ReviewOptions {
  repositoryContext?: RepositoryContext;
  /**
   * Head-revision source the model may search and read before the review.
   * Callers pass it only when exploration is enabled.
   */
  explorationReader?: RepositoryReader;
  /** Replaces the exploration model transport. Used by tests. */
  exploreExecute?: AgentExecutor;
  repositoryConfig?: RepositoryConfig;
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
  'Use the supplied repository contracts to prioritize security, correctness, reliability,',
  'performance, and compatibility risks; check workload limits before alleging a performance defect.',
  'Concentrate on changed failure paths: removed guards, widened catch blocks, fallback returns,',
  'and what the shown callers do with those values. Report a finding only when the supplied source',
  'demonstrates it. Returning an empty findings array is the correct answer for a sound diff.',
].join(' ');

/**
 * Recall-oriented passes that always run beside the main review.
 *
 * Benchmarking showed the main pass reports one or two issues per PR and stops,
 * missing ordinary concrete bugs, while evidence validation rejects few drafts.
 * Each focused pass narrows attention to one class of defect; the independent
 * validation stage is what protects precision.
 */
const HUNT_PREAMBLE = [
  'Hunt for concrete defects introduced by this diff in the focus area below. An independent pass',
  'verifies every finding against the source, so report each distinct source-supported defect in',
  'this area, including medium and low severity ones, rather than only the most serious issue.',
  'Examine every changed hunk.',
].join(' ');
const HUNT_RULES =
  'Cite the exact changed line for each finding and state its trigger and consequence. Do not report style preferences or speculative risks without a concrete trigger.';

export const HUNT_FOCUS = {
  logic: [
    'Focus: logic and data flow. Look for wrong variable, parameter, key, field or route names;',
    'calls to the wrong function, object or delegate, including accidental recursion into the same',
    'method or layer; inverted, missing or misplaced conditions and early returns; off-by-one and',
    'boundary errors; unchecked null, missing-key or empty-collection access; and computing a value',
    'but returning or using a different one.',
  ].join(' '),
  state: [
    'Focus: state, asynchrony and failure handling. Look for asynchronous work that is not awaited',
    'or whose errors are dropped, including async callbacks passed to forEach; check-then-act races',
    'and non-atomic updates; caches or state changed before a call that can fail and never restored;',
    'records, subscriptions or resources that are no longer cleaned up; and errors that are swallowed',
    'or turned into success-like results.',
  ].join(' '),
  contracts: [
    'Focus: contracts and consistency. Look for callers and callees that now disagree on arguments,',
    'return shapes, routes or parameters; behavior that now differs between parallel implementations',
    'or call sites; configuration, documentation, translations or user-visible text that is wrong for',
    'its context; and tests that assert the wrong thing or no longer exercise the changed behavior.',
  ].join(' '),
} as const;

export const HUNT_TASKS = Object.fromEntries(
  Object.entries(HUNT_FOCUS).map(([name, focus]) => [
    name,
    `${HUNT_PREAMBLE} ${focus} ${HUNT_RULES}`,
  ]),
) as Record<keyof typeof HUNT_FOCUS, string>;

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

export function createDefaultStages(
  config: ReviewConfig,
  execute?: AgentExecutor,
  validateFindings = true,
): ReviewStage[] {
  const shared = {
    concurrency: config.concurrency,
    partitionTimeoutMs: config.partitionTimeoutMs,
    ...(execute ? { execute } : {}),
  };
  return [
    createStaticStage(),
    createModelStage({ name: 'model-review', ...shared }),
    ...(config.huntEnabled
      ? [
          createParallelStage(
            'model-hunt',
            config.huntFocus.map((focus) =>
              createModelStage({
                name: `model-hunt-${focus}`,
                task: HUNT_TASKS[focus],
                noteWhenEmpty: `The ${focus} defect hunt found no additional concrete defects.`,
                // Optional: a failed hunt leaves the main review intact and is reported.
                optional: true,
                ...shared,
              }),
            ),
          ),
        ]
      : []),
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
    ...(validateFindings ? [createFindingValidation(execute)] : []),
  ];
}

export function buildReviewContext(diff: DiffInput, options: ReviewOptions = {}): ReviewContext {
  const expected = diffSha256(diff.bytes);
  if (diff.sha256 !== expected) {
    throw new Error('diff input SHA-256 does not match its exact bytes');
  }

  const config = { ...reviewConfig(), ...options.config };
  const repository = options.repositoryConfig ?? DEFAULT_REPOSITORY_CONFIG;
  const feedback = options.feedback ?? process.env.AGENT_EVAL_FEEDBACK;
  const framing = {
    ...(feedback === undefined ? {} : { feedback }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  };
  // Two budgets: the ceiling the transport accepts, and the smaller size the
  // model answers reliably at. The packer prefers the second and uses the
  // first only for a file too large to fit it.
  // Reserve space for a bounded candidate allegation in the evidence-validation pass.
  const budget = availableDiffBytes(diff, framing) - 12 * 1024;
  const target = availableDiffBytes(diff, framing, config.partitionBytes);

  const files = indexDiff(diff.text).filter((file) => !excluded(file.path, repository));
  // Diff packing is unchanged by context. Each packet then receives repository context
  // up to the room left under the hard message ceiling, so context never makes a
  // reviewable file unreviewable.
  const packets = evidencePackets(files, budget, target);
  return {
    diff,
    packets: options.repositoryContext
      ? packets.map((packet) =>
          enrichPacket(
            packet,
            options.repositoryContext!,
            Math.min(config.contextBytes, Math.max(0, budget - Buffer.byteLength(packet.text))),
          ),
        )
      : packets,
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
  let effective = options;
  let explorationNote = '';
  if (options.explorationReader) {
    const reader = options.explorationReader;
    const exploration = await exploreRepository({
      diff: diff.text,
      diffSha256: diff.sha256,
      reader,
      config: options.repositoryConfig ?? DEFAULT_REPOSITORY_CONFIG,
      ask:
        options.exploreExecute ??
        ((message, timeoutMs) => runModelChild(message, timeoutMs, 'explore')),
      // Exploration may use at most a third of the review's time.
      deadline: Deadline.in(Math.floor(config.deadlineMs / 3)),
      callTimeoutMs: config.partitionTimeoutMs,
      limits: { rounds: config.exploreRounds },
      ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
    });
    effective = {
      ...options,
      repositoryContext: withExploredFiles(
        reader.revision,
        options.repositoryContext,
        exploration.files,
      ),
      config: { ...options.config, contextBytes: config.contextBytes + config.exploreContextBytes },
    };
    explorationNote = `Exploration: ${exploration.searches} searches and ${exploration.reads} reads over ${exploration.rounds} rounds added ${exploration.files.length} files (${exploration.stopped}).`;
  }
  const context = buildReviewContext(diff, effective);
  const stages =
    options.stages ??
    createDefaultStages(
      config,
      options.execute,
      options.repositoryConfig?.validateFindings ?? true,
    );
  const result = await runPipeline(context, stages);
  const excludedCount =
    indexDiff(diff.text).length -
    new Set(
      context.packets.flatMap((packet) =>
        [...packet.targets].map((id) => packet.anchors.get(id)!.file),
      ),
    ).size;
  const coverage = [
    excludedCount > 0
      ? `${excludedCount} changed files had no reviewed source targets (excluded or metadata-only).`
      : '',
    effective.repositoryContext
      ? `Repository context: ${effective.repositoryContext.files.length} selected files at ${effective.repositoryContext.revision}; ${effective.repositoryContext.limited ? 'bounded selection' : 'all candidate paths scanned'}.`
      : 'Context was limited to the supplied diff.',
    explorationNote,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...result,
    review: { ...result.review, rationale: `${result.review.rationale} ${coverage}` },
  };
}

/** Review a diff and return the verdict. */
export async function reviewDiff(diff: DiffInput, options: ReviewOptions = {}): Promise<Review> {
  const { review } = await reviewDiffDetailed(diff, options);
  return review;
}
