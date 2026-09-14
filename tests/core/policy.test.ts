import { describe, expect, it } from 'vitest';
import {
  decideVerdict,
  describeVerdictPolicy,
  severityRank,
  VERDICT_RULES,
  verdictMismatch,
} from '../../src/core/policy.js';
import { validateReview } from '../../src/core/schema.js';

const rated = (...severities: Array<'blocker' | 'major' | 'minor' | 'info'>) =>
  severities.map((severity) => ({ severity }));

describe('verdict policy', () => {
  it('maps each severity tier to its verdict', () => {
    expect(decideVerdict(rated())).toEqual({ risk: 'low', blocked: false });
    expect(decideVerdict(rated('info', 'minor'))).toEqual({ risk: 'low', blocked: false });
    expect(decideVerdict(rated('minor', 'major'))).toEqual({ risk: 'medium', blocked: true });
    expect(decideVerdict(rated('major', 'blocker'))).toEqual({ risk: 'high', blocked: true });
  });

  it('applies the first matching rule, so a blocker outranks a major', () => {
    expect(VERDICT_RULES.map((rule) => rule.id)).toEqual(['blocker-present', 'major-present']);
    expect(decideVerdict(rated('blocker', 'major')).risk).toBe('high');
  });

  it('reports the specific disagreement between findings and a claimed verdict', () => {
    expect(verdictMismatch(rated('major'), { risk: 'medium', blocked: true })).toBeUndefined();
    expect(verdictMismatch(rated('major'), { risk: 'medium', blocked: false })).toMatch(/blocked/);
    expect(verdictMismatch(rated('minor'), { risk: 'high', blocked: false })).toMatch(/risk must/);
  });

  it('orders severities worst first', () => {
    expect(
      ['info', 'blocker', 'minor', 'major'].sort(
        (a, b) => severityRank(a as never) - severityRank(b as never),
      ),
    ).toEqual(['blocker', 'major', 'minor', 'info']);
  });

  it('is the only definition the schema validator enforces', () => {
    const review = {
      schema_version: '1.0' as const,
      input_sha256: 'a'.repeat(64),
      risk: 'low' as const,
      blocked: false,
      findings: [
        {
          severity: 'blocker' as const,
          category: 'security' as const,
          file: 'a.ts',
          line: 1,
          detail: 'Authorization is bypassed.',
        },
      ],
      rationale: 'Mismatched on purpose.',
    };
    expect(() => validateReview(review)).toThrow(/blocked must be true/);
  });

  it('renders the rule table for the system prompt', () => {
    const described = describeVerdictPolicy();
    for (const rule of VERDICT_RULES) {
      expect(described).toContain(rule.description);
    }
    expect(described).toContain('risk must be low and blocked false');
  });
});
