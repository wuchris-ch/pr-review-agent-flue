// One ReviewBench review: the agent's passes through the engine, as findings with a location.
// adapter.mjs calls this with a live agent; evals/reviewbench/findings.mjs calls it with saved answers.
import { parseAgentFindings } from '../../dist/agents/agent-reviewer.js';
import { decodeDiff } from '../../dist/core/input.js';
import { DEFAULT_REPOSITORY_CONFIG } from '../../dist/core/repository-config.js';
import { reviewDiffDetailed } from '../../dist/review-service.js';
import { mergeAgentPasses } from '../../dist/stages/agent-stage.js';

// The engine indexes the diff to tie findings to changed lines. It refuses a diff over 1 MiB, a
// change with a binary file, a file too large for one model message and text that is not UTF-8.
// The agent reads the checkout itself, so none of these stops it from reviewing.
const NOT_INDEXABLE =
  /^(diff input exceeds|diff input must be valid UTF-8|binary changes require|a single diff file exceeds)/;

/**
 * Returns the review's findings as { file, line, message }, and the engine's reason when it could
 * not index the diff. Without changed-line grounding, such a pull request still gets its review:
 * the passes run, their findings are merged, and each keeps the location the agent gave it.
 */
export async function reviewPullRequest({ diffBytes, repo, passes, grounding, validate, run, repositoryContext }) {
  try {
    const result = await reviewDiffDetailed(decodeDiff(diffBytes), {
      repositoryConfig: { ...DEFAULT_REPOSITORY_CONFIG, validateFindings: validate },
      ...(repositoryContext ? { repositoryContext: await repositoryContext() } : {}),
      agentReview: { root: repo, validate, grounding, passes, run },
    });
    return {
      findings: result.review.findings.map((finding) => ({ file: finding.file, line: finding.line, message: finding.detail })),
    };
  } catch (error) {
    if (grounding !== 'off' || !NOT_INDEXABLE.test(error.message)) throw error;
    const settled = await Promise.allSettled(passes.map((lens) => run(lens)));
    const answers = settled.filter((pass) => pass.status === 'fulfilled').map((pass) => pass.value);
    if (answers.length === 0) throw settled[0].reason;
    const parsed = answers.map((answer) => parseAgentFindings(answer, repo));
    return {
      notIndexed: error.message,
      findings: (parsed.length > 1 ? mergeAgentPasses(parsed) : parsed[0]).map((finding) => ({
        file: finding.file,
        line: finding.line,
        message: finding.body ? finding.title + '. ' + finding.body : finding.title,
      })),
    };
  }
}
