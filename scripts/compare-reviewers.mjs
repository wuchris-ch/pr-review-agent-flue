#!/usr/bin/env node
// Sequential, alternating paired invocations. Reports contain review content: keep them private.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--baseline', '--candidate', '--cases', '--out', '--trials'].includes(args[i]) || !args[i + 1]) throw new Error('usage: compare-reviewers.mjs --baseline DIR --candidate DIR --cases JSON --out PRIVATE_JSON [--trials 3]');
  options[args[i].slice(2)] = args[i + 1];
}
for (const key of ['baseline', 'candidate', 'cases', 'out']) if (!options[key]) throw new Error(`missing --${key}`);
const trials = Number(options.trials ?? 3);
if (!Number.isInteger(trials) || trials < 1 || trials > 3) throw new Error('trials must be 1 through 3');
const cases = JSON.parse(readFileSync(options.cases));
if (!Array.isArray(cases) || cases.length < 1 || cases.length > 32) throw new Error('provide 1 through 32 development cases');
const inputs = new Map();
for (const testcase of cases) {
  if (typeof testcase.id !== 'string' || inputs.has(testcase.id)) throw new Error('case IDs must be unique');
  inputs.set(testcase.id, readFileSync(resolve(dirname(options.cases), testcase.diff)));
}
if (existsSync(options.out)) throw new Error('output already exists; previous trials must be preserved');
const gateway = process.env.MODEL_GATEWAY_BASE_URL;
const credential = process.env.MODEL_GATEWAY_API_KEY;
if (!gateway || !credential || !process.env.REVIEW_AGENT_MODEL) throw new Error('local model gateway configuration is required');
const destination = new URL(gateway.replace(/\/$/, '') + '/chat/completions');
if (destination.protocol !== 'https:') throw new Error('comparison upstream must use HTTPS');
const token = randomBytes(24).toString('hex');
const records = [];
const identity = root => ({
  commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tracked_diff_sha256: hash(execFileSync('git', ['-C', root, 'diff', '--binary', 'HEAD'])),
  lock_sha256: hash(readFileSync(resolve(root, 'package-lock.json'))),
});
const report = {
  schema_version: '1.0', purpose: 'paired development comparison', started_at: new Date().toISOString(),
  model_alias: 'model-gateway/reviewer', order: 'baseline first on odd pairs, candidate first on even pairs; sequential',
  baseline: identity(resolve(options.baseline)), candidate: identity(resolve(options.candidate)),
  cases: cases.map(c => ({ id: c.id, input_sha256: hash(inputs.get(c.id)) })),
  trials, planned_invocations: trials * cases.length * 2, records,
};
mkdirSync(dirname(resolve(options.out)), { recursive: true, mode: 0o700 });
const save = () => writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
let active;
const server = createServer(async (request, response) => {
  if (!active || request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
  const record = active;
  if (record.requests.length >= 6) { response.writeHead(429).end(); return; }
  const item = { phase: 'initial', status: null, response_bytes: 0, usage: null, model_output: '', message_sha256: null };
  record.requests.push(item);
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error(); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body);
    const messages = JSON.stringify(payload.messages);
    item.message_sha256 = hash(messages);
    if (messages.includes('Protocol correction:')) item.phase = 'correction';
    const upstream = await fetch(destination, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, redirect: 'error', signal: AbortSignal.timeout(35_000) });
    item.status = upstream.status;
    if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); response.writeHead(upstream.status).end('model gateway request failed'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of upstream.body) {
      item.response_bytes += chunk.length;
      if (item.response_bytes > 1024 * 1024) throw new Error();
      response.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5));
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') item.model_output += delta;
          if (event.usage && ['prompt_tokens', 'completion_tokens'].every(key => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0)) {
            item.usage = { input_tokens: event.usage.prompt_tokens, output_tokens: event.usage.completion_tokens };
          }
        } catch { /* Empty lines, [DONE], and non-JSON events carry no usage. */ }
      }
      if (pending.length > 256 * 1024) throw new Error();
    }
    response.end();
  } catch { item.transport_error = true; response.destroy(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const proxyUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
  let pair = 0;
  for (let trial = 1; trial <= trials; trial++) for (const testcase of cases) {
    const order = pair++ % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const variant of order) {
      const input = inputs.get(testcase.id);
      const record = { case_id: testcase.id, trial, variant, started_at: new Date().toISOString(), requests: [], exit_code: null, latency_ms: null, output: null, error: null };
      records.push(record); active = record; save();
      const env = { ...process.env, MODEL_GATEWAY_BASE_URL: proxyUrl, MODEL_GATEWAY_API_KEY: token };
      for (const key of Object.keys(env)) if (key.startsWith('OTEL_') || key === 'AGENT_EVAL_FEEDBACK') delete env[key];
      const start = performance.now();
      const child = spawn(process.execPath, [resolve(options[variant], 'dist/cli.js')], { cwd: resolve(options[variant]), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let stderr = ''; let timedOut = false;
      const kill = () => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(kill, 120_000);
      child.stdout.on('data', c => { output += c; if (output.length > 1024 * 1024) kill(); });
      child.stderr.on('data', c => { stderr += c; if (stderr.length > 1024 * 1024) kill(); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
      const [code] = await once(child, 'close'); clearTimeout(timer);
      record.latency_ms = Math.round(performance.now() - start); record.exit_code = code;
      record.stdout_sha256 = hash(output); record.stderr_sha256 = hash(stderr);
      try { record.output = JSON.parse(output); } catch { record.error = 'invalid output'; }
      if (code !== 0) record.error = timedOut ? 'execution timeout' : 'nonzero exit';
      record.correction_requests = record.requests.filter(r => r.phase === 'correction').length;
      active = undefined; save();
      console.log(JSON.stringify({ case: testcase.id, trial, variant, exit: code, blocked: record.output?.blocked ?? null, findings: record.output?.findings?.length ?? null, requests: record.requests.length, corrections: record.correction_requests, latency_ms: record.latency_ms }));
    }
  }
  report.completed_at = new Date().toISOString(); save();
} finally { server.closeAllConnections(); server.close(); }
