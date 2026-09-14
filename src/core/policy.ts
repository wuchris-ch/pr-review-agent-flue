/**
 * Verdict policy: the single source of truth for how findings become a
 * risk level and a blocking decision.
 *
 * This used to live in three places that could drift: prose in the system
 * prompt, a hand-written check in the schema validator, and a third
 * recomputation in the partition aggregator. The rule table below is now
 * the only definition. The validator calls it, the aggregator calls it,
 * and `describeVerdictPolicy()` renders it into the system prompt so the
 * model is told exactly what the application will enforce.
 */

export const SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;
export const CATEGORIES = ['security', 'correctness', 'style', 'performance'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Risk = (typeof RISKS)[number];

export interface Verdict {
  risk: Risk;
  blocked: boolean;
}

/** The minimum shape the policy needs. Keeps this module free of schema imports. */
export interface Rated {
  severity: Severity;
}

export interface VerdictRule {
  /** Stable identifier, used in telemetry and test names. */
  readonly id: string;
  /** Rendered into the system prompt. Keep it one imperative sentence. */
  readonly description: string;
  readonly matches: (findings: readonly Rated[]) => boolean;
  readonly verdict: Verdict;
}

const hasSeverity =
  (severity: Severity) =>
  (findings: readonly Rated[]): boolean =>
    findings.some((finding) => finding.severity === severity);

/**
 * Evaluated in order; the first match wins. Adding a tier means adding a
 * row here and nothing else.
 */
export const VERDICT_RULES: readonly VerdictRule[] = [
  {
    id: 'blocker-present',
    description: 'Any blocker finding means risk high and blocked true.',
    matches: hasSeverity('blocker'),
    verdict: { risk: 'high', blocked: true },
  },
  {
    id: 'major-present',
    description: 'Otherwise, any major finding means risk medium and blocked true.',
    matches: hasSeverity('major'),
    verdict: { risk: 'medium', blocked: true },
  },
];

export const DEFAULT_VERDICT: Verdict = { risk: 'low', blocked: false };

export const DEFAULT_VERDICT_DESCRIPTION =
  'Otherwise, risk must be low and blocked false, including minor-only and info-only findings.';

/** Map findings to the verdict the application will enforce. */
export function decideVerdict(findings: readonly Rated[]): Verdict {
  for (const rule of VERDICT_RULES) {
    if (rule.matches(findings)) {
      return rule.verdict;
    }
  }
  return DEFAULT_VERDICT;
}

/**
 * Describe a verdict that disagrees with the policy, or undefined when it
 * agrees. Returning the message rather than throwing lets the schema layer
 * own its own error type.
 */
export function verdictMismatch(findings: readonly Rated[], claimed: Verdict): string | undefined {
  const expected = decideVerdict(findings);
  if (claimed.blocked !== expected.blocked) {
    return 'blocked must be true exactly when a blocker or major finding is present';
  }
  if (claimed.risk !== expected.risk) {
    return `risk must be ${expected.risk} for these findings`;
  }
  return undefined;
}

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** Render the rule table as prompt text so the prompt cannot drift from the code. */
export function describeVerdictPolicy(): string {
  return [
    ...VERDICT_RULES.map((rule) => `- ${rule.description}`),
    `- ${DEFAULT_VERDICT_DESCRIPTION}`,
  ].join('\n');
}
