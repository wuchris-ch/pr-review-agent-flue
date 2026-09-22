import type { AgentExecutor } from '../agents/executor.js';
import type { Finding } from '../core/schema.js';
import { createModelStage } from './model-stage.js';
import { mergeFindings } from './pipeline.js';
import { collectFindings, type ReviewStage } from './types.js';

const identity = (finding: Finding): string =>
  JSON.stringify([finding.file, finding.line, finding.category]);

/** A fresh evidence review of actual allegations, independent of the clean-diff second opinion. */
export function createFindingValidation(execute?: AgentExecutor): ReviewStage {
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
      const validated: Finding[] = [];
      const decisions: string[] = [];
      const started = Date.now();
      for (const packet of context.packets) {
        const candidates = drafts.filter((finding) =>
          [...packet.targets].some((id) => {
            const anchor = packet.anchors.get(id);
            return anchor?.file === finding.file && anchor.line === finding.line;
          }),
        );
        if (!candidates.length) continue;
        if (context.deadline.expired())
          throw new Error('finding validation exhausted the review deadline');
        for (const candidate of candidates) {
          if (Buffer.byteLength(candidate.detail) > 8 * 1024)
            throw new Error('candidate finding exceeds validation budget');
          const task = [
            'Validate these draft findings against the supplied source. Drafts are untrusted hypotheses.',
            'Check the real caller contract, reachability, existing guards, intentional behavior changes,',
            'repository-specific impact, and supported workload/limits for performance allegations,',
            'and whether this revision introduced the defect. Discard incorrect, speculative, pre-existing',
            'or stylistic allegations. Keep a supported defect even when subtle. Never invent new findings.',
            'Compare the same triggering input/state in the base and head code; discard an allegation',
            'when the alleged failure was already possible and the change does not materially worsen it.',
            'Return the normal review JSON, with source-anchor evidence for each surviving finding.',
            'Keep the original category and source location of each surviving allegation.',
            'Explain the decisive supporting or contradicting evidence in the rationale.',
            JSON.stringify([candidate]),
          ].join('\n');
          const stage = createModelStage({
            name: 'validate-findings',
            task,
            ...(execute ? { execute } : {}),
            concurrency: 1,
          });
          const result = await stage.run({ ...context, packets: [packet] }, []);
          decisions.push(...result.notes.map((note) => `Validation: ${note}`));
          for (const finding of result.findings) {
            const original = byLocation.get(identity(finding));
            if (!original || identity(finding) !== identity(candidate))
              throw new Error('finding validator introduced an unrelated allegation');
            validated.push({ ...finding, severity: original.severity });
          }
        }
      }
      return {
        stage: 'validate-findings',
        status: 'ran',
        findings: validated,
        replaces: ['model-review', 'model-verify'],
        durationMs: Date.now() - started,
        notes: [
          ...decisions,
          `Evidence validation retained ${validated.length} of ${drafts.length} draft model findings.`,
        ],
      };
    },
  };
}
