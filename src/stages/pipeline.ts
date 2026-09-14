import { decideVerdict, severityRank } from '../core/policy.js';
import { type Finding, type Review, validateReview } from '../core/schema.js';
import {
  collectFindings,
  type ReviewContext,
  type ReviewStage,
  type StageResult,
  skipped,
} from './types.js';

const MAX_RATIONALE_CHARS = 4096;

export interface PipelineResult {
  review: Review;
  stages: readonly StageResult[];
  /** Number of diff partitions the review covered. */
  partitions: number;
}

/** Identity of the defect itself, independent of who reported it or how. */
function locationKey(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line, finding.category]);
}

const CORROBORATION_NOTE = 'Another independent check reported this same location.';

/**
 * Stable ordering: worst first, then by location, so two runs over the same
 * diff produce byte-identical output regardless of stage completion order.
 */
function compareFindings(left: Finding, right: Finding): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.category.localeCompare(right.category) ||
    left.detail.localeCompare(right.detail)
  );
}

/**
 * Collapse the findings from every stage into one list.
 *
 * Stages overlap on purpose: a deterministic detector and the model can
 * both flag the same line, and that agreement is a good signal rather than
 * two separate problems. Findings that share a file, line, and category are
 * therefore treated as one defect. The most severe report wins, since a
 * stage that understood the impact better should not be outvoted by one
 * that understood it less well, and the reader is told that something else
 * agreed.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = locationKey(finding);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const merged: Finding[] = [];
  for (const group of groups.values()) {
    const distinct = [...new Map(group.map((finding) => [finding.detail, finding])).values()];
    const [primary] = [...distinct].sort(compareFindings) as [Finding, ...Finding[]];
    merged.push(
      distinct.length > 1
        ? { ...primary, detail: `${primary.detail}\n${CORROBORATION_NOTE}` }
        : primary,
    );
  }

  return merged.sort(compareFindings);
}

interface StageRun {
  costClass: ReviewStage['costClass'];
  result: StageResult;
}

/**
 * Lead with the reviewer's own summary, then any supporting notes.
 *
 * Stages run in cost order, so a deterministic note would otherwise open the
 * rationale and bury the explanation a reader actually wants.
 */
function buildRationale(runs: readonly StageRun[]): string {
  const notesFrom = (costClass: ReviewStage['costClass']) =>
    runs.filter((run) => run.costClass === costClass).flatMap((run) => run.result.notes);

  const notes = [...new Set([...notesFrom('model'), ...notesFrom('free')].filter(Boolean))];
  const text = notes.length ? notes.join(' ') : 'No actionable defects found.';
  return text.slice(0, MAX_RATIONALE_CHARS);
}

/**
 * Run stages in order, letting each one decide whether it is still needed.
 *
 * Stages are sequential on purpose: gating only means something if a later
 * stage can see what earlier ones found. Parallelism lives inside a stage,
 * across the partitions it reviews.
 */
export async function runPipeline(
  context: ReviewContext,
  stages: readonly ReviewStage[],
): Promise<PipelineResult> {
  const results: StageResult[] = [];
  const runs: StageRun[] = [];
  const record = (stage: ReviewStage, result: StageResult): void => {
    results.push(result);
    runs.push({ costClass: stage.costClass, result });
  };

  for (const stage of stages) {
    if (context.deadline.expired()) {
      record(stage, skipped(stage.name, 'review deadline expired'));
      continue;
    }
    if (!stage.shouldRun(context, results)) {
      record(stage, skipped(stage.name, 'gated by an earlier stage'));
      continue;
    }
    record(stage, await stage.run(context, results));
  }

  const findings = mergeFindings(collectFindings(results));
  const verdict = decideVerdict(findings);

  return {
    review: validateReview({
      schema_version: '1.0',
      input_sha256: context.diff.sha256,
      risk: verdict.risk,
      blocked: verdict.blocked,
      findings,
      rationale: buildRationale(runs),
    }),
    stages: results,
    partitions: context.packets.length,
  };
}
