#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitReader, retrieveContext } from '../dist/context/repository.js';
import { decodeDiff } from '../dist/core/input.js';
import { parseRepositoryConfig } from '../dist/core/repository-config.js';
import { reviewDiffDetailed } from '../dist/review-service.js';
import { createModelStage } from '../dist/stages/model-stage.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = {
  dataset: 'scenarios',
  limit: 50,
  repeats: 1,
  arms: 'single-pass,diff-pipeline,context-pipeline,context-validated',
  concurrency: 1,
  cases: '',
  label: '',
  // Bare repositories from scripts/fetch-benchmark-sources.py; required by context-explored.
  sources: '',
};
for (let n = 2; n < process.argv.length; n += 2) {
  const key = process.argv[n].replace(/^--/, '');
  if (!(key in options) || !process.argv[n + 1])
    throw new Error(
      'usage: compare-pipeline.mjs --dataset scenarios|external --limit N --repeats N --arms single-pass,diff-pipeline,context-pipeline,context-validated,context-explored [--concurrency N] [--cases id,id|@file] [--label name] [--sources dir]',
    );
  options[key] = ['limit', 'repeats', 'concurrency'].includes(key)
    ? Number(process.argv[n + 1])
    : process.argv[n + 1];
}
if (
  !['scenarios', 'external'].includes(options.dataset) ||
  !Number.isInteger(options.limit) ||
  options.limit < 1 ||
  options.limit > 50 ||
  !Number.isInteger(options.repeats) ||
  options.repeats < 1 ||
  options.repeats > 5 ||
  !Number.isInteger(options.concurrency) ||
  options.concurrency < 1 ||
  options.concurrency > 16 ||
  !/^[\w.-]*$/.test(options.label)
)
  throw new Error('invalid comparison bounds');
const arms = options.arms.split(',');
const ARMS = [
  'single-pass',
  'diff-pipeline',
  'context-pipeline',
  'context-validated',
  'context-explored',
];
if (
  new Set(arms).size !== arms.length ||
  arms.some((arm) => !ARMS.includes(arm)) ||
  (arms.includes('context-explored') && (options.dataset !== 'external' || !options.sources))
)
  throw new Error('invalid comparison arms');
const directory = resolve(
  root,
  'evals/results',
  `comparison-${Date.now()}${options.label ? `-${options.label}` : ''}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const selected = options.cases.startsWith('@')
  ? readFileSync(resolve(options.cases.slice(1)), 'utf8').split(/[\s,]+/)
  : options.cases.split(',');
const wanted = new Set(selected.map((id) => id.trim()).filter(Boolean));
const cases = JSON.parse(
  readFileSync(
    resolve(
      root,
      options.dataset === 'scenarios'
        ? 'examples/scenarios/manifest.json'
        : 'evals/external/manifest.json',
    ),
    'utf8',
  ),
)
  .filter((item) => wanted.size === 0 || wanted.has(item.id))
  .slice(0, options.limit);
if (wanted.size > 0 && cases.length !== Math.min(wanted.size, options.limit))
  throw new Error('some selected cases are not in the manifest');
const config = parseRepositoryConfig(undefined);
const rows = [];
const environment = {
  model: process.env.REVIEW_AGENT_MODEL ?? null,
  reasoningEffort: process.env.REVIEW_REASONING_EFFORT ?? null,
};
const writeSummary = () =>
  writeFileSync(
    resolve(directory, 'summary.json'),
    `${JSON.stringify({ version: 1, dataset: options.dataset, model: 'reviewer', environment, options, rows }, null, 2)}\n`,
    { mode: 0o600 },
  );
const prepared = new Map();
const prepare = (item) => {
  if (!prepared.has(item.id)) prepared.set(item.id, loadCase(item));
  return prepared.get(item.id);
};
async function loadCase(item) {
  const fixture = options.dataset === 'scenarios';
  const base = resolve(
    root,
    fixture ? `examples/scenarios/${item.directory}` : `evals/external/${item.id}`,
  );
  const bytes = readFileSync(resolve(base, fixture ? `${item.variant}.diff` : 'change.diff'));
  const diff = decodeDiff(bytes);
  const files = fixture
    ? Object.fromEntries(
        readdirSync(resolve(base, item.variant)).map((path) => [
          path,
          readFileSync(resolve(base, item.variant, path), 'utf8'),
        ]),
      )
    : JSON.parse(readFileSync(resolve(base, 'context.json'), 'utf8'));
  const revision = fixture
    ? createHash('sha256').update(JSON.stringify(files)).digest('hex')
    : item.head;
  const context = await retrieveContext(
    diff.text,
    {
      revision,
      paths: async () => Object.keys(files),
      read: async (path) => files[path],
    },
    config,
  );
  if (!fixture) context.limited = true; // Imported context is a frozen, bounded repository subset.
  return { fixture, diff, context };
}
/** Exploration reads the PR's exact head revision from a local bare repository. */
function explorationReaderFor(item, arm) {
  if (arm !== 'context-explored') return undefined;
  const project = item.id.slice(0, item.id.lastIndexOf('-'));
  const repository = resolve(options.sources, `${project}.git`);
  if (!existsSync(repository))
    throw new Error('benchmark source repository is missing; run fetch-benchmark-sources.py');
  return gitReader(repository, item.head);
}
const tasks = [];
for (const item of cases)
  for (let repetition = 1; repetition <= options.repeats; repetition++)
    for (const arm of arms) tasks.push({ item, repetition, arm });
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const { item, repetition, arm } = tasks[next++];
    const { fixture, diff, context } = await prepare(item);
    // Gold annotations and expected locations never enter the review request.
    {
      const started = Date.now();
      const attempts = [];
      const name = `${item.id}-${arm}-${repetition}`;
      try {
        const explorationReader = explorationReaderFor(item, arm);
        const result = await reviewDiffDetailed(diff, {
          onAttempt: (attempt) => attempts.push(attempt),
          repositoryConfig: {
            ...config,
            validateFindings: arm === 'context-validated' || arm === 'context-explored',
          },
          ...(arm.startsWith('context-') ? { repositoryContext: context } : {}),
          ...(explorationReader ? { explorationReader } : {}),
          ...(arm === 'single-pass' ? { stages: [createModelStage()] } : {}),
        });
        writeFileSync(resolve(directory, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`, {
          mode: 0o600,
        });
        const hit =
          fixture &&
          result.review.findings.some((f) => f.file === item.file && f.line === item.line);
        rows.push({
          case: item.id,
          arm,
          repetition,
          status: 'completed',
          latencyMs: Date.now() - started,
          modelCalls: attempts.length,
          inputBytes: attempts.reduce((n, a) => n + a.messageBytes, 0),
          usage: attempts.every((a) => a.usage)
            ? attempts.reduce(
                (total, a) => ({
                  inputTokens: total.inputTokens + a.usage.inputTokens,
                  outputTokens: total.outputTokens + a.usage.outputTokens,
                }),
                { inputTokens: 0, outputTokens: 0 },
              )
            : null,
          costUsd: null,
          findings: result.review.findings.length,
          ...(fixture
            ? {
                expectedBug: !item.expected_pass,
                caughtExpectedBug: !item.expected_pass && hit,
                cleanControlPassed: item.expected_pass ? result.review.findings.length === 0 : null,
              }
            : { adjudication: 'pending' }),
        });
      } catch (error) {
        rows.push({
          case: item.id,
          arm,
          repetition,
          status: 'failed',
          latencyMs: Date.now() - started,
          modelCalls: attempts.length,
          error: String(error?.message ?? error).slice(0, 300),
        });
      }
      // Write after every case so a stopped experiment remains inspectable.
      writeSummary();
      console.log(`${name}: ${rows.at(-1).status}`);
    }
  }
}
await Promise.all(Array.from({ length: options.concurrency }, worker));
console.log(`Comparison records: ${directory}`);
if (rows.some((row) => row.status !== 'completed')) process.exitCode = 1;
