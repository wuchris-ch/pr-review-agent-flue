import { describe, expect, it } from 'vitest';
import {
  agentBreadthPrompt,
  agentFailureReason,
  agentReviewPrompt,
  claudeResult,
  parseAgentFindings,
} from '../../src/agents/agent-reviewer.js';
import { reviewConfig } from '../../src/core/config.js';
import { decodeDiff } from '../../src/core/input.js';
import { reviewDiffDetailed } from '../../src/review-service.js';
import { mergeAgentPasses } from '../../src/stages/agent-stage.js';

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

describe('several agent passes', () => {
  const finding = (
    priority: 'P0' | 'P1' | 'P2' | 'P3',
    title: string,
    line: number,
    body = '',
  ) => ({
    priority,
    title,
    file: 'src/auth.ts',
    line,
    body,
  });

  it('merges one problem reported by two passes and keeps the longest write-up and highest priority', () => {
    const merged = mergeAgentPasses([
      [finding('P2', 'Owner check requires both roles', 11, 'Short.')],
      [
        finding(
          'P1',
          'Permission check requires owner and admin roles',
          12,
          'A longer explanation of the impact.',
        ),
      ],
    ]);
    expect(merged).toEqual([
      finding(
        'P1',
        'Permission check requires owner and admin roles',
        12,
        'A longer explanation of the impact.',
      ),
    ]);
  });

  it('keeps different problems on neighbouring lines and never merges within one pass', () => {
    const merged = mergeAgentPasses([
      [
        finding('P1', 'Owner check requires both roles', 11),
        finding('P1', 'Owner check requires both roles again', 12),
      ],
      [
        finding('P2', 'Team lookup can return null', 12),
        finding('P3', 'Owner check requires both roles', 40),
      ],
    ]);
    expect(merged.map((item) => [item.title, item.line])).toEqual([
      ['Owner check requires both roles', 11],
      ['Owner check requires both roles again', 12],
      ['Team lookup can return null', 12],
      ['Owner check requires both roles', 40],
    ]);
  });

  it('runs every pass with its own request and merges the proposals', async () => {
    const asked: string[] = [];
    const result = await reviewDiffDetailed(diff, {
      agentReview: {
        validate: false,
        passes: ['bugs', 'breadth'],
        run: async (lens) => {
          asked.push(lens);
          return lens === 'bugs'
            ? '- [P1] Owner check requires both roles | src/auth.ts:11\n  Admins lose edit access.'
            : [
                '- [P2] Owner check now requires both roles | src/auth.ts:11',
                '  The permission check uses && where the contract says ||, so admins who are not owners lose edit access.',
                '- [P3] Comment no longer matches the check | src/auth.ts:11',
                '  The comment above still describes the old rule.',
              ].join('\n');
        },
      },
    });
    expect(asked.sort()).toEqual(['breadth', 'bugs']);
    const agent = result.stages.find((stage) => stage.stage === 'model-agent');
    expect(agent?.notes[0]).toBe(
      'The agent reviewer made 2 passes (1 broad) and proposed 3 findings, 2 distinct; 2 tied to changed lines.',
    );
    expect(agent?.findings.map((item) => item.severity).sort()).toEqual(['major', 'minor']);
    expect(agent?.raw).toContain('Comment no longer matches the check');
  });

  it('keeps the passes that succeed and fails only when every pass fails', async () => {
    const answer =
      '- [P1] Owner check requires both roles | src/auth.ts:11\n  Admins lose edit access.';
    const result = await reviewDiffDetailed(diff, {
      agentReview: {
        validate: false,
        passes: ['bugs', 'bugs'],
        run: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) throw new Error('the agent reviewer exceeded its time budget');
            return answer;
          };
        })(),
      },
    });
    expect(result.review.findings).toHaveLength(1);
    expect(result.stages.find((stage) => stage.stage === 'model-agent')?.notes.join(' ')).toContain(
      '1 agent pass failed: the agent reviewer exceeded its time budget.',
    );
    await expect(
      reviewDiffDetailed(diff, {
        agentReview: {
          validate: false,
          passes: ['bugs', 'breadth'],
          run: async () => {
            throw new Error('not signed in');
          },
        },
      }),
    ).rejects.toThrow('not signed in');
  });

  it('reads the pass counts from the environment and sends the matching request', () => {
    expect(reviewConfig({})).toMatchObject({ agentRuns: 1, agentBreadthRuns: 0 });
    expect(reviewConfig({}).agentBreadthModel).toBeUndefined();
    expect(
      reviewConfig({
        REVIEW_AGENT_RUNS: '3',
        REVIEW_AGENT_BREADTH_RUNS: '2',
        REVIEW_AGENT_BREADTH_MODEL: ' claude-sonnet-5-5 ',
      }),
    ).toMatchObject({ agentRuns: 3, agentBreadthRuns: 2, agentBreadthModel: 'claude-sonnet-5-5' });
    expect(() => reviewConfig({ REVIEW_AGENT_RUNS: '0' })).toThrow('REVIEW_AGENT_RUNS');
    expect(() => reviewConfig({ REVIEW_AGENT_BREADTH_RUNS: '4' })).toThrow(
      'REVIEW_AGENT_BREADTH_RUNS',
    );
    const broad = agentBreadthPrompt('The branch `pr` holds the change.', 'git diff main...pr');
    expect(broad).toContain('Report every distinct problem');
    expect(broad).toContain('`git diff main...pr`');
    expect(broad.split('\n').slice(-4)).toEqual(agentReviewPrompt('x', 'y').split('\n').slice(-4));
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
