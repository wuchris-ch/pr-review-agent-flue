import { describe, expect, it } from 'vitest';
// The ReviewBench integration is a plain module that imports the built engine.
// @ts-expect-error no type declarations
import { reviewPullRequest } from '../../integrations/reviewbench/review-pull-request.mjs';

const text = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const timeout = 5;',
  '+for (let i = 0; i <= items.length; i++) use(items[i]);',
  ' done();',
  '',
].join('\n');
const binary = [
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..1111111',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');
const answers: Record<string, string> = {
  bugs: '- [P1] Wrong bound in the loop | src/a.ts:2\n  The loop reads one element past the end.',
  breadth: [
    '- [P2] Loop bound is wrong | src/a.ts:3',
    '  The condition lets the loop read past the end, and use() gets undefined.',
    '- [P3] Name hides the unit | src/a.ts:1',
    '  Call it timeoutSeconds.',
  ].join('\n'),
};

function review(diff: string, grounding = 'off') {
  const asked: string[] = [];
  const result = reviewPullRequest({
    diffBytes: Buffer.from(diff),
    repo: '/repo',
    validate: false,
    grounding,
    passes: ['bugs', 'breadth'],
    run: async (lens: string) => {
      asked.push(lens);
      return answers[lens];
    },
  }) as Promise<{
    notIndexed?: string;
    findings: { file: string; line: number; message: string }[];
  }>;
  return { result, asked };
}

describe('ReviewBench adapter', () => {
  it('sends the passes through the engine and merges their findings', async () => {
    const { result, asked } = review(text);
    const { findings, notIndexed } = await result;
    expect(notIndexed).toBeUndefined();
    expect(asked).toEqual(['bugs', 'breadth']);
    expect(findings.map((finding) => [finding.file, finding.line])).toEqual([
      ['src/a.ts', 3],
      ['src/a.ts', 1],
    ]);
    expect(findings[0]?.message).toContain('use() gets undefined');
  });

  it('still reviews a change the engine cannot index', async () => {
    for (const [diff, reason] of [
      [text + binary, 'binary changes'],
      [text + '+x\n'.repeat(400_000), 'diff input exceeds'],
    ] as const) {
      const { result, asked } = review(diff);
      const { findings, notIndexed } = await result;
      expect(notIndexed).toContain(reason);
      expect(asked).toEqual(['bugs', 'breadth']);
      expect(findings.map((finding) => finding.line).sort()).toEqual([1, 3]);
    }
  });

  it('keeps the refusal when findings must sit on changed lines', async () => {
    const { result, asked } = review(text + binary, 'exact');
    await expect(result).rejects.toThrow('binary changes');
    expect(asked).toEqual([]);
  });
});
