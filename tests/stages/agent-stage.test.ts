import { describe, expect, it } from 'vitest';
import {
  agentFailureReason,
  claudeResult,
  parseAgentFindings,
} from '../../src/agents/agent-reviewer.js';
import { decodeDiff } from '../../src/core/input.js';
import { reviewDiffDetailed } from '../../src/review-service.js';

const diffText = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,4 @@ export function canEdit(user) {',
  '   const team = load(user);',
  '-  return team.isAdmin || team.isOwner;',
  '+  return team.isAdmin && team.isOwner;',
  '   // unchanged',
  '   // unchanged',
  '',
].join('\n');
const diff = decodeDiff(Buffer.from(diffText));

describe('agent reviewer findings', () => {
  it('parses both separators, strips the checkout root and joins explanation lines', () => {
    const findings = parseAgentFindings(
      [
        'Some preamble the format ignores.',
        '- [P1] Owner check requires both roles | src/auth.ts:11',
        '  Admins who are not owners lose edit access.',
        '  This breaks the documented team contract.',
        '',
        '- [P2] Absolute path from another agent \u2014 /work/repo/src/auth.ts:12-13',
        '  Second explanation.',
        '- [P0] Outside the checkout | /etc/passwd:1',
        '  Ignored.',
      ].join('\n'),
      '/work/repo',
    );
    expect(findings).toEqual([
      {
        priority: 'P1',
        title: 'Owner check requires both roles',
        file: 'src/auth.ts',
        line: 11,
        body: 'Admins who are not owners lose edit access. This breaks the documented team contract.',
      },
      {
        priority: 'P2',
        title: 'Absolute path from another agent',
        file: 'src/auth.ts',
        line: 12,
        body: 'Second explanation.',
      },
    ]);
    expect(parseAgentFindings('No findings.')).toEqual([]);
  });

  it('reads the final answer from Claude Code event output', () => {
    expect(
      claudeResult(
        JSON.stringify([{ type: 'system' }, { type: 'result', result: 'No findings.' }]),
      ),
    ).toBe('No findings.');
    expect(() =>
      claudeResult(JSON.stringify({ type: 'result', is_error: true, result: 'x' })),
    ).toThrow();
  });

  it('ties proposals to the nearest changed line and drops the rest', async () => {
    const answer = [
      '- [P1] Owner check requires both roles | src/auth.ts:12',
      '  Admins who are not owners lose edit access; the permission check uses && instead of ||.',
      '- [P2] Unrelated file | src/other.ts:3',
      '  Not part of this diff.',
    ].join('\n');
    const result = await reviewDiffDetailed(diff, {
      agentReview: { run: async () => answer, validate: false, tolerance: 3 },
    });
    expect(result.review.findings).toHaveLength(1);
    expect(result.review.findings[0]).toMatchObject({
      file: 'src/auth.ts',
      line: 11,
      severity: 'major',
      category: 'security',
    });
    expect(result.review.blocked).toBe(true);
    const agent = result.stages.find((stage) => stage.stage === 'model-agent');
    expect(agent?.raw).toBe(answer);
    expect(agent?.notes.join(' ')).toContain('src/other.ts:3 Unrelated file');
  });

  it('keeps nothing when grounding is exact and the cited line is unchanged', async () => {
    const result = await reviewDiffDetailed(diff, {
      agentReview: {
        run: async () => '- [P2] Context line | src/auth.ts:10\n  Points at unchanged code.',
        validate: false,
        grounding: 'exact',
      },
    });
    expect(result.review.findings).toEqual([]);
  });
});

describe('agent reviewer failures', () => {
  it("reports Claude Code's error result", () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Not logged in · Please run /login',
    });
    expect(agentFailureReason(stdout, 'ignored')).toBe('Not logged in · Please run /login');
  });

  it('falls back to the last stderr line', () => {
    expect(agentFailureReason('', 'warming up\nerror: missing OPENAI_API_KEY\n\n')).toBe(
      'error: missing OPENAI_API_KEY',
    );
    expect(agentFailureReason('', '')).toBe('');
  });
});
