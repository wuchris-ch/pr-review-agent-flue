import { describe, expect, it, vi } from 'vitest';
import { decodeDiff } from '../src/input.js';
import { evidencePackets, groundReview, indexDiff, MAX_CONTEXT_BYTES } from '../src/evidence.js';
import { reviewDiff } from '../src/runner.js';

const traversal = [
  'diff --git a/paths.py b/paths.py', '--- a/paths.py', '+++ b/paths.py',
  '@@ -3,4 +3,4 @@ from pathlib import Path',
  ' ', ' def upload_path(root, name):', '     candidate = (root / name).resolve()',
  '-    if candidate not in root:', '+    if False and candidate not in root:', '',
].join('\n');

function response(digest: string, anchor = 'F1N6', quote = 'False and') {
  return JSON.stringify({
    schema_version: '1.0', input_sha256: digest, risk: 'high', blocked: true,
    findings: [{ severity: 'blocker', category: 'security', evidence: { anchor, quote }, detail: 'The disabled guard permits paths outside the upload root. Restore containment validation.' }],
    rationale: 'Containment validation is disabled.',
  });
}

describe('source provenance', () => {
  it('resolves the changed operation despite nonzero offsets and a misleading hunk suffix', () => {
    const diff = decodeDiff(Buffer.from(traversal));
    const packet = evidencePackets(indexDiff(traversal), 90_000)[0]!;
    const review = groundReview(response(diff.sha256), packet, diff.sha256);
    expect(review.findings[0]).toMatchObject({ file: 'paths.py', line: 6 });
    expect(review.findings[0]?.detail).toContain('Evidence (head): "False and"');
    expect(review.findings[0]).not.toHaveProperty('evidence');
  });

  it('rejects a real context line as the primary defect location', () => {
    const diff = decodeDiff(Buffer.from(traversal));
    const packet = evidencePackets(indexDiff(traversal), 90_000)[0]!;
    expect(() => groundReview(response(diff.sha256, 'F1N5', 'candidate'), packet, diff.sha256)).toThrow(/exact supplied source anchor/);
  });

  it('rejects invented source, removed replacements, and missing anchors without echoing output', () => {
    const packet = evidencePackets(indexDiff(traversal), 90_000)[0]!;
    for (const [id, quote] of [['F1N6', 'private-invented-source'], ['F1O6', 'candidate'], ['F9N1', 'False and']]) {
      expect(() => groundReview(response('a'.repeat(64), id, quote), packet, 'a'.repeat(64))).toThrow('finding evidence must quote an exact supplied source anchor');
    }
  });

  it('repairs bad evidence once and records both first-pass and correction outcomes', () => {
    const diff = decodeDiff(Buffer.from(traversal));
    const events: string[] = [];
    const execute = vi.fn().mockReturnValueOnce({ status: 0, stdout: response(diff.sha256, 'F1N5', 'candidate'), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: response(diff.sha256), stderr: '' });
    expect(reviewDiff(diff, execute, { onAttempt: (event) => events.push(`${event.attempt}:${event.outcome}`) }).findings[0]?.line).toBe(6);
    expect(events).toEqual(['1:invalid', '2:accepted']);
    expect(execute.mock.calls[1]?.[0]).not.toContain('Restore containment validation');
  });

  it('shares one correction budget across format and evidence errors, failing closed', () => {
    const diff = decodeDiff(Buffer.from(traversal));
    const execute = vi.fn().mockReturnValueOnce({ status: 0, stdout: 'invalid JSON', stderr: '' })
      .mockReturnValue({ status: 0, stdout: response(diff.sha256, 'F1N5', 'candidate'), stderr: '' });
    expect(() => reviewDiff(diff, execute)).toThrow(/invalid after one/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('preserves explicit base-side provenance for deletion-only changes', () => {
    const text = 'diff --git a/guard.py b/guard.py\n--- a/guard.py\n+++ b/guard.py\n@@ -8,2 +8 @@\n-    authorize(user)\n     return record\n';
    const packet = evidencePackets(indexDiff(text), 90_000)[0]!;
    const review = groundReview(response('a'.repeat(64), 'F1O8', 'authorize(user)'), packet, 'a'.repeat(64));
    expect(review.findings[0]).toMatchObject({ file: 'guard.py', line: 8 });
    expect(review.findings[0]?.detail).toContain('Evidence (base)');
  });

  it('maps new files and multiple hunks without counting removed lines as new lines', () => {
    const text = 'diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -20,2 +20 @@\n-old\n-older\n+new\n@@ -40 +39 @@\n-before\n+after\n\\ No newline at end of file\n';
    const files = indexDiff(text);
    expect(files[1]?.hunks[1]?.anchors.find((a) => a.id === 'F2N39')).toMatchObject({ file: 'b.ts', line: 39, text: 'after' });
    expect(files[0]?.hunks[0]?.anchors[0]).toMatchObject({ id: 'F1N1', line: 1, target: true });
  });

  it('decodes renamed and quoted UTF-8 Git paths', () => {
    const text = 'diff --git a/old.py "b/caf\\303\\251 file.py"\n--- a/old.py\n+++ "b/caf\\303\\251 file.py"\n@@ -1 +1 @@\n-old\n+new\n';
    const file = indexDiff(text)[0]!;
    expect(file.path).toBe('café file.py');
    expect(file.hunks[0]?.anchors[1]?.file).toBe('café file.py');
  });

  it('fails before invoking the model on truncated or ambiguous patches', () => {
    const execute = vi.fn();
    for (const text of [traversal.replace('+3,4', '+3,9'), traversal.replace('paths.py', '../paths.py'), `${traversal}${traversal}`]) {
      expect(() => reviewDiff(decodeDiff(Buffer.from(text)), execute)).toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('bounded context retrieval', () => {
  it('retrieves related caller evidence across partitions without making it another finding target', () => {
    const file = (path: string, content: string[]) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${content.length} @@\n${content.map((line) => '+' + line).join('\n')}\n`;
    const text = file('caller.py', ['from parser import parse_port', 'port = parse_port(config)', 'padding = "' + 'x'.repeat(9000) + '"'])
      + file('parser.py', ['def parse_port(config):', '    return 0', 'padding = "' + 'y'.repeat(9000) + '"']);
    const packets = evidencePackets(indexDiff(text), MAX_CONTEXT_BYTES + 12_000);
    expect(packets).toHaveLength(2);
    expect(packets[0]?.retrievedHunks).toBe(1);
    expect(packets[0]?.anchors.get('F2N2')).toMatchObject({ file: 'parser.py', line: 2 });
    expect(packets[0]?.targets.has('F2N2')).toBe(false);
    expect(packets[0]?.text).toContain('Related context only');
    for (const packet of packets) expect(Buffer.byteLength(packet.text)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES + 12_000);
  });
});
