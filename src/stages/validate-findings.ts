import type { AgentExecutor } from '../agents/executor.js';
import { mapConcurrent } from '../core/concurrency.js';
import type { EvidencePacket } from '../core/diff/types.js';
import type { Finding } from '../core/schema.js';
import { createModelStage } from './model-stage.js';
import { mergeFindings } from './pipeline.js';
import { collectFindings, type ReviewStage } from './types.js';

const identity = (finding: Finding): string =>
  JSON.stringify([finding.file, finding.line, finding.category]);

/** Independent candidate checks in flight at once; each is one bounded model call. */
export const VALIDATION_CONCURRENCY = 4;

/** A fresh evidence review of actual allegations, independent of the clean-diff second opinion. */
export function createFindingValidation(
  execute?: AgentExecutor,
  concurrency = VALIDATION_CONCURRENCY,
): ReviewStage {
  return {
    name: 'validate-findings',
    costClass: 'model',
    required: true,
    shouldRun: (_context, prior) =>
      prior.some((stage) => stage.stage.startsWith('model-') && stage.findings.length > 0),
    async run(context, prior) {
      const drafts = mergeFindings(
        collectFindings(prior.filter((stage) => stage.stage.startsWith('model-'))),
      );
      const byLocation = new Map(drafts.map((finding) => [identity(finding), finding]));
      const started = Date.now();
      const checks: { packet: EvidencePacket; candidate: Finding }[] = [];
      for (const packet of context.packets) {
        for (const candidate of drafts.filter((finding) =>
          [...packet.targets].some((id) => {
            const anchor = packet.anchors.get(id);
            return anchor?.file === finding.file && anchor.line === finding.line;
          }),
        ))
          checks.push({ packet, candidate });
      }
      // Each check is independent, so they run in a bounded pool; results keep input order.
      const outcomes = await mapConcurrent(checks, concurrency, async ({ packet, candidate }) => {
        if (context.deadline.expired())
          throw new Error('finding validation exhausted the review deadline');
        if (Buffer.byteLength(candidate.detail) > 8 * 1024)
          throw new Error('candidate finding exceeds validation budget');
        const task = [
          'Challenge these draft findings against the supplied source. Drafts are untrusted hypotheses,',
          'not authoritative reviews. Start with the strongest source-supported reason each could be wrong.',
          'Check the real caller contract, reachability, existing guards, intentional behavior changes,',
          'repository-specific impact, and supported workload/limits for performance allegations,',
          'and whether this revision introduced the defect or edits the defective expression itself.',
          'Discard incorrect, speculative or stylistic allegations, and pre-existing ones in code this',
          'revision does not edit. Keep a supported defect even when subtle. Never invent new findings.',
          'First apply the claimed triggering input/state to the BASE code, then the HEAD code.',
          'Discard an allegation when its failure was already possible and is not materially worsened,',
          'unless this revision edits the defective expression itself and the defect is concrete.',
          'A newly used API looking riskier is not evidence of new behavior. A surviving finding must',
          'explain its concrete base-to-head behavioral difference in detail.',
          'Return the normal review JSON, with source-anchor evidence for each surviving finding.',
          'Keep the original category and source location of each surviving allegation.',
          'Summarize the base outcome, head outcome, and decisive source evidence in the rationale.',
          JSON.stringify([candidate]),
        ].join('\n');
        const stage = createModelStage({
          name: 'validate-findings',
          task,
          ...(execute ? { execute } : {}),
          concurrency: 1,
        });
        const result = await stage.run({ ...context, packets: [packet] }, []);
        // The validator may only keep or discard the candidate. Anything else it reports,
        // including the same defect moved to another location, is discarded, never added.
        const related = result.findings.filter(
          (finding) =>
            identity(finding) === identity(candidate) && byLocation.has(identity(finding)),
        );
        const kept = related.map((finding) => ({
          ...finding,
          severity: byLocation.get(identity(finding))!.severity,
        }));
        const discarded = result.findings.length - related.length;
        return {
          kept,
          notes: [
            ...result.notes.map((note) => `Validation: ${note}`),
            ...(discarded
              ? [
                  `Validation discarded ${discarded} allegation(s) that were not the candidate under review.`,
                ]
              : []),
          ],
        };
      });
      const validated = outcomes.flatMap((outcome) => outcome.kept);
      const decisions = outcomes.flatMap((outcome) => outcome.notes);
      return {
        stage: 'validate-findings',
        status: 'ran',
        findings: validated,
        // Every draft-producing model stage is superseded by its validated findings.
        replaces: prior.filter((stage) => stage.stage.startsWith('model-')).map((s) => s.stage),
        durationMs: Date.now() - started,
        notes: [
          ...decisions,
          `Evidence validation retained ${validated.length} of ${drafts.length} draft model findings.`,
        ],
      };
    },
  };
}
