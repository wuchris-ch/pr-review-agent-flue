import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnvironment } from '../src/runner.js';

const diff = 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n';
const sha = createHash('sha256').update(diff).digest('hex');
const verdict = { schema_version: '1.0', input_sha256: sha, risk: 'low', blocked: false, findings: [], rationale: 'No actionable defects found.' };
let mode: 'valid' | 'format' | 'digest' | 'retry' | 'auth' | 'exhaust' | 'blocked' = 'valid';
let requests: Array<Record<string, any>> = [];
let headers: Array<IncomingMessage['headers']> = [];

function completion(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = { id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test-wire-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  headers.push(request.headers);
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  if (mode === 'auth' || mode === 'exhaust' || (mode === 'retry' && requests.length === 1)) {
    response.writeHead(mode === 'auth' ? 401 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'private-upstream-sentinel' } }));
    return;
  }
  const output = mode === 'digest' ? { ...verdict, input_sha256: 'b'.repeat(64) }
    : mode === 'blocked' ? { ...verdict, blocked: true, risk: 'high', findings: [{ severity: 'blocker', category: 'security', evidence: { anchor: 'F1N1', quote: 'export const answer = 42;' }, detail: 'Synthetic blocking finding for contract verification.' }] }
    : verdict;
  completion(response, mode === 'format' && requests.length === 1 ? 'not valid JSON' : JSON.stringify(output));
});
let baseUrl: string;

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

async function review(testMode: typeof mode) {
  mode = testMode; requests = []; headers = [];
  const child = spawn(process.execPath, ['dist/cli.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...childEnvironment({ PATH: process.env.PATH }), MODEL_GATEWAY_BASE_URL: baseUrl, MODEL_GATEWAY_API_KEY: 'test-only-key', REVIEW_AGENT_MODEL: 'test-wire-model', GITHUB_TOKEN: 'github-token-must-not-reach-model' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 25_000,
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdin.end(diff);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

describe('compiled CLI through real Flue and Pi against loopback SSE', () => {
  it('returns the original JSON contract through the registered Flue agent', async () => {
    const result = await review('valid');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(verdict);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.model).toBe('test-wire-model');
    expect(request.stream).toBe(true);
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(4096);
    expect(request.tools ?? []).toEqual([]);
    expect(JSON.stringify(request.messages)).toContain('senior pull-request reviewer');
    expect(JSON.stringify(request.messages)).toContain(sha);
    expect(JSON.stringify(request)).not.toContain('github-token-must-not-reach-model');
    expect(headers[0]?.authorization).toBe('Bearer test-only-key');
  });

  it('repairs invalid output once with a fresh Flue conversation', async () => {
    const result = await review('format');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(verdict);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain('Protocol correction');
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('not valid JSON');
  });

  it('rejects a valid-looking verdict for the wrong diff', async () => {
    const result = await review('digest');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('does not match');
    expect(requests).toHaveLength(1);
  });

  it('preserves blocked verdicts as valid JSON with exit zero', async () => {
    const result = await review('blocked');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).blocked).toBe(true);
  });

  it('recovers from a transient HTTP error inside Flue', async () => {
    const result = await review('retry');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(verdict);
    expect(requests).toHaveLength(2);
  }, 30_000);

  it('fails closed without leaking upstream error text on auth failure', async () => {
    const result = await review('auth');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-upstream-sentinel');
    expect(requests).toHaveLength(1);
  });

  it('caps sustained upstream failure at three actual requests', async () => {
    const result = await review('exhaust');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(requests).toHaveLength(3);
  }, 30_000);
});
