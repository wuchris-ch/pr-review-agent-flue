import { describe, expect, it } from 'vitest';
import { extractReview } from '../src/json.js';

const json = JSON.stringify({
  schema_version: '1.0',
  input_sha256: 'b'.repeat(64),
  risk: 'low',
  blocked: false,
  findings: [],
  rationale: 'No actionable issue was found.',
});

describe('extractReview', () => {
  it('accepts exactly one JSON object with surrounding whitespace', () => {
    expect(extractReview(` \n${json}\n`)).toEqual(JSON.parse(json));
  });

  it('handles braces and escaped quotes inside strings', () => {
    const response = JSON.stringify({
      ...JSON.parse(json),
      rationale: 'A literal { value } and "quoted" text are safe.',
    });
    expect(extractReview(response).rationale).toContain('{ value }');
  });

  it('accepts one JSON-only Markdown fence', () => {
    expect(extractReview(`\`\`\`json\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
    expect(extractReview(`\`\`\`JSON\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
    expect(extractReview(`\`\`\`\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
  });

  it('rejects prefixes, suffixes, malformed fences, and multiple values', () => {
    expect(() => extractReview(`runner started\n${json}`)).toThrow(/only one/);
    expect(() => extractReview(`${json}\nrunner finished`)).toThrow(/trailing/);
    expect(() => extractReview(`analysis\n\`\`\`json\n${json}\n\`\`\``)).toThrow(/only one/);
    expect(() => extractReview(`\`\`\`json\n${json}\n\`\`\`\ntrailing`)).toThrow(/only one/);
    expect(() => extractReview(`${json}\n${json}`)).toThrow(/multiple/);
  });

  it('rejects duplicate keys at every object depth', () => {
    expect(() =>
      extractReview(json.replace('"risk":"low"', '"risk":"low","risk":"high"')),
    ).toThrow(/duplicate JSON key/);

    const nestedDuplicate = JSON.stringify({
      ...JSON.parse(json),
      risk: 'high',
      blocked: true,
      findings: [
        {
          severity: 'blocker',
          category: 'security',
          file: 'src/auth.ts',
          line: 1,
          detail: 'Authorization is bypassed.',
        },
      ],
    }).replace('"line":1', '"line":1,"line":2');
    expect(() => extractReview(nestedDuplicate)).toThrow(/duplicate JSON key/);
  });

  it('fails on empty, non-JSON, and schema-invalid output', () => {
    expect(() => extractReview('')).toThrow(/no output/);
    expect(() => extractReview('analysis complete')).toThrow(/only one JSON/);
    expect(() => extractReview('{"risk":"low"}')).toThrow(/does not match/);
  });
});
