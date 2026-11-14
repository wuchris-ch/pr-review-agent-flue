import { type AgentFinding, type AgentLens, parseAgentFindings } from '../agents/agent-reviewer.js';
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

/** Lines two reports of one problem may sit apart. Agents cite the same defect a line or two off. */
const MERGE_LINE_DISTANCE = 3;
/** Share of title words two reports of one problem have in common, at least. */
const MERGE_TITLE_OVERLAP = 0.2;
const TITLE_STOP_WORDS = new Set(
  'the a an of to in is and or for on with that this it as be are not when by from at if'.split(
    ' ',
  ),
);

function titleWords(title: string): Set<string> {
  return new Set(
    (title.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
      (word) => word.length > 2 && !TITLE_STOP_WORDS.has(word),
    ),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

const PRIORITY_RANK: Record<AgentFinding['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Merge the proposals of several independent passes into one list.
 *
 * Passes repeat each other: on ReviewBench's test set five passes proposed 24
 * findings per pull request, about half of them repeats. Two proposals from
 * different passes are one problem when they cite the same file within three
 * lines and their titles share words. Location alone merged different problems
 * on neighbouring lines and cost five points of recall; the title check kept
 * four of them. One pass does not repeat itself, so its own proposals never
 * merge. Each group keeps its longest write-up and its highest priority.
 */
export function mergeAgentPasses(passes: readonly (readonly AgentFinding[])[]): AgentFinding[] {
  const entries = passes.flatMap((findings, pass) =>
    findings.map((finding) => ({ finding, pass, words: titleWords(finding.title) })),
  );
  const parent = entries.map((_, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  for (let left = 0; left < entries.length; left += 1)
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left]!;
      const b = entries[right]!;
      if (
        a.pass !== b.pass &&
        a.finding.file === b.finding.file &&
        Math.abs(a.finding.line - b.finding.line) <= MERGE_LINE_DISTANCE &&
        overlap(a.words, b.words) >= MERGE_TITLE_OVERLAP
      )
        parent[root(left)] = root(right);
    }
  const groups = new Map<number, AgentFinding[]>();
  entries.forEach((entry, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), entry.finding]);
  });
  const length = (finding: AgentFinding) => finding.title.length + finding.body.length;
  return [...groups.values()].map((group) => {
    const longest = group.reduce((best, finding) =>
      length(finding) > length(best) ? finding : best,
    );
    const priority = group.reduce(
      (best, finding) =>
        PRIORITY_RANK[finding.priority] < PRIORITY_RANK[best] ? finding.priority : best,
      longest.priority,
    );
    return { ...longest, priority };
  });
}

export interface AgentStageOptions {
  /** Runs the agent once with the given review request and returns its findings text. */
  readonly review: (context: ReviewContext, lens: AgentLens) => Promise<string>;
  /** One entry per independent agent pass, run at the same time. Defaults to one `bugs` pass. */
  readonly passes?: readonly AgentLens[];
  /** Checkout root, stripped from absolute paths the agent may print. */
  readonly root?: string;
  readonly grounding?: Grounding;
  readonly tolerance?: number;
}

const count = (n: number, noun = 'finding', plural = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : plural}`;

/**
 * A draft-producing stage backed by a coding agent that explored the checkout itself.
 *
 * With several passes the agent reviews the change that many times at once, and
 * the proposals are merged before they are tied to the diff. A failed pass is
 * reported and the others still count; the stage fails only when every pass fails.
 */
export function createAgentStage(options: AgentStageOptions): ReviewStage {
  const grounding = options.grounding ?? 'near';
  const tolerance = options.tolerance ?? 0;
  const passes: readonly AgentLens[] = options.passes?.length ? options.passes : ['bugs'];
  return {
    name: 'model-agent',
    costClass: 'model',
    required: true,
    shouldRun: (context) => context.packets.length > 0,
    async run(context) {
      const started = Date.now();
      const settled = await Promise.allSettled(passes.map((lens) => options.review(context, lens)));
      const answers = settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (answers.length === 0) throw failures[0];
      const parsed = answers.map((answer) => parseAgentFindings(answer, options.root ?? ''));
      const proposed = parsed.reduce((total, findings) => total + findings.length, 0);
      const proposals = passes.length > 1 ? mergeAgentPasses(parsed) : parsed[0]!;
      const { findings, dropped } = groundAgentFindings(proposals, context, grounding, tolerance);
      const broad = passes.filter((lens) => lens === 'breadth').length;
      return {
        stage: 'model-agent',
        status: 'ran',
        findings,
        notes: [
          passes.length > 1
            ? `The agent reviewer made ${count(passes.length, 'pass', 'passes')}${broad ? ` (${String(broad)} broad)` : ''} and proposed ${count(proposed)}, ${String(proposals.length)} distinct; ${String(findings.length)} tied to changed lines.`
            : `The agent reviewer proposed ${count(proposals.length)}; ${String(findings.length)} tied to changed lines.`,
          ...(failures.length
            ? [
                `${count(failures.length, 'agent pass', 'agent passes')} failed: ${String((failures[0] as Error | undefined)?.message ?? failures[0]).slice(0, 200)}.`,
              ]
            : []),
          ...(dropped.length
            ? [
                `Not tied to a changed line: ${dropped
                  .map((finding) => `${finding.file}:${String(finding.line)} ${finding.title}`)
                  .join('; ')}.`,
              ]
            : []),
        ],
        durationMs: Date.now() - started,
        raw: answers.join('\n\n'),
      };
    },
  };
}
