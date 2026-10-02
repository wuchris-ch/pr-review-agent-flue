import type { ReviewStage, StageResult } from './types.js';

/**
 * Run independent stages at the same time and report them as one stage.
 *
 * The pipeline is sequential so later stages can gate on earlier findings.
 * Focused defect hunts do not depend on each other, so running them in
 * sequence only multiplied review latency. Sub-stage failures are kept in
 * the notes and reason so a reader can tell which hunt did not complete.
 */
export function createParallelStage(name: string, stages: readonly ReviewStage[]): ReviewStage {
  return {
    name,
    costClass: 'model',
    required: stages.some((stage) => stage.required),
    shouldRun: (context, prior) => stages.some((stage) => stage.shouldRun(context, prior)),
    async run(context, prior): Promise<StageResult> {
      const startedAt = Date.now();
      const results = await Promise.all(
        stages
          .filter((stage) => stage.shouldRun(context, prior))
          .map((stage) => stage.run(context, prior)),
      );
      const incomplete = results.filter((result) => result.status !== 'ran');
      return {
        stage: name,
        status: incomplete.length === results.length ? 'failed' : 'ran',
        findings: results.flatMap((result) => [...result.findings]),
        notes: results.flatMap((result) => [...result.notes]),
        durationMs: Date.now() - startedAt,
        ...(incomplete.length
          ? {
              reason: incomplete
                .map((result) => `${result.stage}: ${result.reason ?? result.status}`)
                .join('; '),
            }
          : {}),
      };
    },
  };
}
