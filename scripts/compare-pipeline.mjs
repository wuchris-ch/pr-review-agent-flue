#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieveContext } from '../dist/context/repository.js';
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
};
for (let n = 2; n < process.argv.length; n += 2) {
  const key = process.argv[n].replace(/^--/, '');
  if (!(key in options) || !process.argv[n + 1])
    throw new Error(
      'usage: compare-reviewers.mjs --dataset scenarios|external --limit N --repeats N --arms single-pass,diff-pipeline,context-pipeline,context-validated',
    );
  options[key] = ['limit', 'repeats'].includes(key)
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
  options.repeats > 5
)
  throw new Error('invalid comparison bounds');
const arms = options.arms.split(',');
if (
  new Set(arms).size !== arms.length ||
  arms.some(
    (arm) =>
      !['single-pass', 'diff-pipeline', 'context-pipeline', 'context-validated'].includes(arm),
  )
)
  throw new Error('invalid comparison arms');
const directory = resolve(root, 'evals/results', `comparison-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
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
).slice(0, options.limit);
const config = parseRepositoryConfig(undefined);
const rows = [];
for (const item of cases) {
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
    { revision, paths: async () => Object.keys(files), read: async (path) => files[path] },
    config,
  );
  if (!fixture) context.limited = true; // Imported context is a frozen, bounded repository subset.
  // Gold annotations and expected locations never enter the review request.
  for (let repetition = 1; repetition <= options.repeats; repetition++)
    for (const arm of arms) {
      const started = Date.now();
      const attempts = [];
      const name = `${item.id}-${arm}-${repetition}`;
      try {
        const result = await reviewDiffDetailed(diff, {
          onAttempt: (attempt) => attempts.push(attempt),
          repositoryConfig: { ...config, validateFindings: arm === 'context-validated' },
          ...(arm.startsWith('context-') ? { repositoryContext: context } : {}),
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
      } catch {
        rows.push({
          case: item.id,
          arm,
          repetition,
          status: 'failed',
          latencyMs: Date.now() - started,
          modelCalls: attempts.length,
        });
      }
      // Write after every case so a stopped experiment remains inspectable.
      writeFileSync(
        resolve(directory, 'summary.json'),
        `${JSON.stringify({ version: 1, dataset: options.dataset, model: 'reviewer', options, rows }, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(`${name}: ${rows.at(-1).status}`);
    }
}
console.log(`Comparison records: ${directory}`);
if (rows.some((row) => row.status !== 'completed')) process.exitCode = 1;
