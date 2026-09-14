#!/usr/bin/env node
/**
 * Graded evaluation over labelled diffs.
 *
 * Two kinds of signal, kept apart on purpose. Whether a review blocks, and
 * whether it points at the expected file and line, is objective, so a
 * disagreement fails the run. Severity wording, rationale quality, and extra
 * findings are subjective, so they are reported in the summary and never
 * gate.
 *
 * Results land in a timestamped directory with a schema version so a later
 * comparison can tell one format from another. Reviews contain repository
 * content, so results stay local and are not committed.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = resolve(ROOT, 'evals/manifest.json');
const RESULTS_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const options = { set: 'smoke', concurrency: 3, fail: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--no-fail') {
      options.fail = false;
    } else if (flag === '--set' || flag === '--concurrency') {
      const value = argv[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === '--set') options.set = value;
      else options.concurrency = Number(value);
    } else {
      throw new Error(
        'usage: run-eval.mjs [--set smoke|full|holdout] [--concurrency N] [--no-fail]',
      );
    }
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 8
  ) {
    throw new Error('--concurrency must be an integer between 1 and 8');
  }
  return options;
}

async function reviewCase(testCase) {
  const diffPath = resolve(dirname(MANIFEST), testCase.diff);
  const startedAt = Date.now();
  try {
    const { stdout } = await run(process.execPath, ['dist/cli.js', '--diff', diffPath], {
      cwd: ROOT,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return { review: JSON.parse(stdout), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { error: String(error.message).split('\n')[0], latencyMs: Date.now() - startedAt };
  }
}

/** Objective checks only. Everything else is reported, not graded. */
function grade(testCase, review) {
  const failures = [];
  if (review.blocked !== testCase.blocked) {
    failures.push(`expected blocked=${testCase.blocked}, got ${review.blocked}`);
  }
  for (const expected of testCase.expect ?? []) {
    const hit = review.findings.find(
      (finding) => finding.file === expected.file && finding.line === expected.line,
    );
    if (!hit) {
      failures.push(`no finding at ${expected.file}:${expected.line}`);
    } else if (expected.severity && hit.severity !== expected.severity) {
      failures.push(
        `severity at ${expected.file}:${expected.line} was ${hit.severity}, expected ${expected.severity}`,
      );
    }
  }
  return failures;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(setName, records) {
  const latencies = records.map((record) => record.latencyMs);
  const failed = records.filter((record) => record.failures.length > 0 || record.error);
  const lines = [
    `# Eval: ${setName}`,
    '',
    `- cases: ${records.length}`,
    `- passed: ${records.length - failed.length}`,
    `- failed: ${failed.length}`,
    `- latency p50: ${(percentile(latencies, 0.5) / 1000).toFixed(1)}s`,
    `- latency p95: ${(percentile(latencies, 0.95) / 1000).toFixed(1)}s`,
    '',
    '| case | expected | verdict | findings | latency | result |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of records) {
    const verdict = record.error ? 'error' : record.review.blocked ? 'blocked' : 'clean';
    const findings = record.error ? '-' : String(record.review.findings.length);
    const result = record.error
      ? `error: ${record.error}`
      : record.failures.length
        ? record.failures.join('; ')
        : 'ok';
    lines.push(
      `| ${record.id} | ${record.expected ? 'blocked' : 'clean'} | ${verdict} | ${findings} | ${(record.latencyMs / 1000).toFixed(1)}s | ${result} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!manifest.sets[options.set]) {
    throw new Error(`unknown set: ${options.set}. Known: ${Object.keys(manifest.sets).join(', ')}`);
  }

  const cases = manifest.cases.filter((testCase) => testCase.sets.includes(options.set));
  if (cases.length === 0) throw new Error(`set ${options.set} has no cases`);
  process.stderr.write(`running ${cases.length} case(s) in set ${options.set}\n`);

  const records = await mapConcurrent(cases, options.concurrency, async (testCase) => {
    const outcome = await reviewCase(testCase);
    const record = {
      id: testCase.id,
      notes: testCase.notes,
      expected: testCase.blocked,
      latencyMs: outcome.latencyMs,
      failures: outcome.error ? [] : grade(testCase, outcome.review),
      ...(outcome.error ? { error: outcome.error } : { review: outcome.review }),
    };
    const status = record.error || record.failures.length ? 'FAIL' : 'ok  ';
    process.stderr.write(`  ${status} ${testCase.id} (${(record.latencyMs / 1000).toFixed(1)}s)\n`);
    return record;
  });

  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const directory = resolve(ROOT, 'evals/results', `${stamp}-${options.set}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, 'results.json'),
    `${JSON.stringify(
      {
        schema_version: RESULTS_SCHEMA_VERSION,
        set: options.set,
        model: process.env.REVIEW_AGENT_MODEL ?? null,
        started_at: stamp,
        records,
      },
      null,
      2,
    )}\n`,
  );
  const summary = summarize(options.set, records);
  writeFileSync(resolve(directory, 'summary.md'), summary);
  process.stdout.write(summary);
  process.stderr.write(`\nwrote ${directory}\n`);

  const failures = records.filter((record) => record.failures.length > 0 || record.error).length;
  process.exitCode = options.fail && failures > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`eval failed: ${error.message}\n`);
  process.exitCode = 1;
});
