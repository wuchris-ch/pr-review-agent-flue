import { type AgentFinding, parseAgentFindings } from '../agents/agent-reviewer.js';
import type { SourceAnchor } from '../core/diff/types.js';
import type { Category, Finding, Severity } from '../core/schema.js';
import type { ReviewContext, ReviewStage } from './types.js';

const SEVERITY: Record<AgentFinding['priority'], Severity> = {
  P0: 'blocker',
  P1: 'major',
  P2: 'minor',
  P3: 'minor',
};

const SECURITY =
  /\b(security|injection|xss|csrf|ssrf|authenticat|authoriz|permission|privilege|bypass|secret|credential|leak|tenant|sanitiz|unescaped|escaping)/i;
const PERFORMANCE =
  /\b(performance|n\+1|quadratic|latency|throughput|unbounded memory|memory growth)/i;

function categoryOf(text: string): Category {
  if (SECURITY.test(text)) return 'security';
  if (PERFORMANCE.test(text)) return 'performance';
  return 'correctness';
}

/**
 * How proposals are tied to the diff.
 * `exact` keeps only findings on a changed line; `near` also accepts the closest
 * changed line within the tolerance; `off` keeps the agent's own locations.
 */
export type Grounding = 'exact' | 'near' | 'off';

export interface GroundedAgentFindings {
  findings: Finding[];
  dropped: AgentFinding[];
}

function targets(context: ReviewContext): SourceAnchor[] {
  const seen = new Map<string, SourceAnchor>();
  for (const packet of context.packets)
    for (const id of packet.targets) {
      const anchor = packet.anchors.get(id);
      if (anchor) seen.set(`${anchor.file}:${anchor.side}:${String(anchor.line)}`, anchor);
    }
  return [...seen.values()];
}

function nearest(
  anchors: SourceAnchor[],
  line: number,
  tolerance: number,
): SourceAnchor | undefined {
  let best: SourceAnchor | undefined;
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.line - line);
    if (distance <= tolerance && (!best || distance < Math.abs(best.line - line))) best = anchor;
  }
  return best;
}

/**
 * Tie each agent proposal to a line this change edits.
 *
 * The application, not the agent, owns every published location: a proposal is
 * kept only when its cited line, or the closest changed line within the
 * tolerance, is a reviewable target in the indexed diff.
 */
export function groundAgentFindings(
  proposals: readonly AgentFinding[],
  context: ReviewContext,
  grounding: Grounding,
  tolerance: number,
): GroundedAgentFindings {
  const anchors = targets(context);
  const findings: Finding[] = [];
  const dropped: AgentFinding[] = [];
  for (const proposal of proposals) {
    const detail = proposal.body ? `${proposal.title}. ${proposal.body}` : proposal.title;
    const base = {
      severity: SEVERITY[proposal.priority],
      category: categoryOf(detail),
      detail,
    };
    if (grounding === 'off') {
      findings.push({ ...base, file: proposal.file, line: proposal.line });
      continue;
    }
    const inFile = anchors.filter((anchor) => anchor.file === proposal.file);
    const head = inFile.filter((anchor) => anchor.side === 'head');
    const limit = grounding === 'exact' ? 0 : tolerance;
    const anchor =
      nearest(head, proposal.line, limit) ??
      nearest(
        inFile.filter((candidate) => candidate.side === 'base'),
        proposal.line,
        limit,
      );
    if (anchor) findings.push({ ...base, file: anchor.file, line: anchor.line });
    else dropped.push(proposal);
  }
  return { findings, dropped };
}

export interface AgentStageOptions {
  /** Runs the agent and returns its findings text. */
  readonly review: (context: ReviewContext) => Promise<string>;
  /** Checkout root, stripped from absolute paths the agent may print. */
  readonly root?: string;
  readonly grounding?: Grounding;
  readonly tolerance?: number;
}

/** A draft-producing stage backed by a coding agent that explored the checkout itself. */
export function createAgentStage(options: AgentStageOptions): ReviewStage {
  const grounding = options.grounding ?? 'near';
  const tolerance = options.tolerance ?? 0;
  return {
    name: 'model-agent',
    costClass: 'model',
    required: true,
    shouldRun: (context) => context.packets.length > 0,
    async run(context) {
      const started = Date.now();
      const raw = await options.review(context);
      const proposals = parseAgentFindings(raw, options.root ?? '');
      const { findings, dropped } = groundAgentFindings(proposals, context, grounding, tolerance);
      const count = (n: number) => `${String(n)} ${n === 1 ? 'finding' : 'findings'}`;
      return {
        stage: 'model-agent',
        status: 'ran',
        findings,
        notes: [
          `The agent reviewer proposed ${count(proposals.length)}; ${String(findings.length)} tied to changed lines.`,
          ...(dropped.length
            ? [
                `Not tied to a changed line: ${dropped
                  .map((finding) => `${finding.file}:${String(finding.line)} ${finding.title}`)
                  .join('; ')}.`,
              ]
            : []),
        ],
        durationMs: Date.now() - started,
        raw,
      };
    },
  };
}
