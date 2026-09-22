import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { usageMetadata } from '../../src/agents/executor.js';
import { enrichPacket, retrieveContext, safeSourcePath } from '../../src/context/repository.js';
import { decodeDiff } from '../../src/core/input.js';
import { parseRepositoryConfig, pathMatches } from '../../src/core/repository-config.js';
import { DeliveryQueue } from '../../src/github/app.js';
import { appJwt, validWebhook } from '../../src/github/app-auth.js';
import { reviewEvent } from '../../src/github/events.js';
import { inlineComments } from '../../src/github/inline.js';
import { buildReviewContext, reviewDiffDetailed } from '../../src/review-service.js';

const diff = decodeDiff(
  Buffer.from(
    'diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-return authorize(user)\n+return true\n',
  ),
);
const config = parseRepositoryConfig(undefined);
const proposal = (findings: unknown[]) =>
  JSON.stringify({
    schema_version: '1.0',
    input_sha256: diff.sha256,
    risk: findings.length ? 'high' : 'low',
    blocked: !!findings.length,
    findings,
    rationale: findings.length ? 'Draft allegation.' : 'Guard already exists.',
  });
const allegation = {
  severity: 'blocker',
  category: 'security',
  evidence: { anchor: 'F1N1', quote: 'return true' },
  detail: 'Authorization always succeeds.',
};

describe('portable review policy and evidence', () => {
  it('rejects executable settings and bounds config size', () => {
    expect(() => parseRepositoryConfig('{"version":1,"command":"echo hello"}')).toThrow();
    expect(() => parseRepositoryConfig(' '.repeat(17000))).toThrow();
    expect(config.failOnFindings).toBe(false);
    expect(pathMatches('a/tests/unit.py', '**/tests/**')).toBe(true);
    expect(pathMatches('tests/unit.py', '**/tests/**')).toBe(true);
    expect(pathMatches('src/a.ts', '*.ts')).toBe(false);
    expect(pathMatches('src/a.ts', '**/*.ts')).toBe(true);
    expect(pathMatches('src/a.ts', 'src/[a].ts')).toBe(false);
  });
  it('retrieves bounded immutable context and cannot blame unchanged files', async () => {
    const read = vi.fn(async () => 'export function authorize(user) { return user.isAdmin; }');
    const repository = await retrieveContext(
      diff.text,
      {
        revision: 'a'.repeat(40),
        paths: async () => [
          '.env',
          'secrets.key',
          '../escape.ts',
          'contracts.ts',
          ...Array.from({ length: 60 }, (_, n) => `z${n}.ts`),
        ],
        read,
      },
      config,
    );
    expect(read).toHaveBeenCalledTimes(40);
    expect(repository.files).toHaveLength(12);
    expect(repository.limited).toBe(true);
    const original = buildReviewContext(diff).packets[0]!;
    const enriched = enrichPacket(original, repository, 12 * 1024);
    expect(enriched.text).toContain('Repository context');
    expect(enriched.targets).toEqual(original.targets);
    expect(
      [...enriched.anchors.values()].filter((a) => a.id.startsWith('R')).every((a) => !a.target),
    ).toBe(true);
    expect(safeSourcePath('a\0.ts')).toBe(false);
    expect(safeSourcePath('a/node_modules/x.ts')).toBe(false);
  });
  it('replaces rejected model allegations and their rationale', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: proposal([allegation]), stderr: '' })
      .mockResolvedValue({ status: 0, stdout: proposal([]), stderr: '' });
    const result = await reviewDiffDetailed(diff, { execute });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.review.blocked).toBe(false);
    expect(result.review.rationale).not.toContain('Draft allegation');
    expect(result.review.rationale).toContain('retained 0 of 1');
  });
  it('fails the run when required evidence validation fails', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 0, stdout: proposal([allegation]), stderr: '' })
      .mockResolvedValue({ status: 2, stdout: '', stderr: '' });
    await expect(reviewDiffDetailed(diff, { execute })).rejects.toThrow('gateway');
    await expect(reviewDiffDetailed(diff, { config: { deadlineMs: 0 } })).rejects.toThrow(
      'deadline',
    );
  });
  it('keeps an excluded diff visibly outside review coverage without model spending', async () => {
    const execute = vi.fn();
    const result = await reviewDiffDetailed(diff, {
      repositoryConfig: { ...config, exclude: ['auth.ts'] },
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.review.rationale).toContain('1 changed files had no reviewed source targets');
  });
  it('publishes bounded inline comments and suppresses only current bot duplicates', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 0, stdout: proposal([allegation]), stderr: '' });
    const { review } = await reviewDiffDetailed(diff, { execute });
    const comments = inlineComments(review, diff.text, [], 'bot', config);
    expect(comments[0]).toMatchObject({ path: 'auth.ts', line: 1, side: 'RIGHT' });
    const previous = [
      { id: 1, path: 'auth.ts', line: 1, body: comments[0]!.body, user: { login: 'bot' } },
    ];
    expect(inlineComments(review, diff.text, previous, 'bot', config)).toEqual([]);
    expect(inlineComments(review, diff.text, previous, 'other-bot', config)).toHaveLength(1);
    expect(
      inlineComments(review, diff.text, [{ ...previous[0]!, line: null }], 'bot', config),
    ).toHaveLength(1);
  });
  it('accepts only numeric child usage metadata', () => {
    expect(
      usageMetadata('REVIEW_USAGE {"inputTokens":12,"outputTokens":3,"secret":"ignored"}'),
    ).toEqual({ usage: { inputTokens: 12, outputTokens: 3 } });
    expect(usageMetadata('REVIEW_USAGE {"inputTokens":-1,"outputTokens":3}')).toEqual({});
  });
});

describe('event-driven GitHub App', () => {
  const event = {
    repository: 'owner/repo',
    number: 1,
    automatic: false,
    sender: 'maintainer',
    installation: 2,
  };
  it('parses exact on-demand commands and ignores irrelevant events', () => {
    expect(reviewEvent('installation', {})).toBeUndefined();
    const payload = {
      action: 'created',
      repository: { full_name: event.repository },
      sender: { login: event.sender },
      issue: { number: 1, pull_request: {} },
      comment: { body: '/review' },
    };
    expect(reviewEvent('issue_comment', payload)).toMatchObject({ number: 1, automatic: false });
    expect(
      reviewEvent('issue_comment', { ...payload, comment: { body: '/review execute this' } }),
    ).toBeUndefined();
    expect(() =>
      reviewEvent('workflow_dispatch', { ...payload, inputs: { 'pull-request': '1; command' } }),
    ).toThrow();
  });
  it('verifies signed webhook bytes and issues bounded RSA JWTs', () => {
    const body = Buffer.from('{"hello":"world"}');
    const secret = 'test-only-webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(validWebhook(body, signature, secret)).toBe(true);
    expect(validWebhook(Buffer.from('{}'), signature, secret)).toBe(false);
    expect(validWebhook(body, 'sha256=00', secret)).toBe(false);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt('123', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1000);
    const [header, claims, signaturePart] = jwt.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: '123',
      iat: 940,
      exp: 1540,
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signaturePart!, 'base64url'),
      ),
    ).toBe(true);
  });
  it('persists queued work across restart and deduplicates redeliveries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-queue-'));
    const run = vi.fn(async () => {});
    let queue = new DeliveryQueue(join(directory, 'queue.db'), run);
    queue.enqueue('delivery-1', event);
    queue.close();
    queue = new DeliveryQueue(join(directory, 'queue.db'), run);
    expect(queue.enqueue('delivery-1', event)).toBe('duplicate');
    await Promise.all([queue.drain(), queue.drain()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.state('delivery-1')).toBe('done');
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
