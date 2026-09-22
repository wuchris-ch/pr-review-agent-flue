#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retrieveContext } from '../dist/context/repository.js';
import { parseRepositoryConfig } from '../dist/core/repository-config.js';
import { GitHubClient } from '../dist/github/client.js';

// Pin annotation provenance. Review inputs are also frozen by exact Git SHAs and byte digests.
const revision = 'e616e849755441da38f18bf3adba2c9583b03803';
const upstream = `https://raw.githubusercontent.com/withmartian/code-review-benchmark/${revision}`;
const output = fileURLToPath(new URL('../evals/external/', import.meta.url));
mkdirSync(output, { recursive: true, mode: 0o700 });
async function download(path) {
  const response = await fetch(`${upstream}/${path}`, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('benchmark source unavailable');
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('benchmark source exceeds limit');
  return text;
}
writeFileSync(resolve(output, 'UPSTREAM-LICENSE'), await download('LICENSE'));
const token =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const client = new GitHubClient(token);
const limit =
  process.argv.length === 2
    ? 50
    : process.argv[2] === '--limit' && process.argv.length === 4
      ? Number(process.argv[3])
      : 0;
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
  throw new Error('usage: import-external-benchmark.mjs [--limit 1..50]');
const manifestPath = resolve(output, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
if (manifest.some((item) => item.annotationRevision !== revision))
  throw new Error('existing benchmark uses a different annotation revision');
let visited = 0;
for (const project of ['cal_dot_com', 'sentry', 'discourse', 'grafana', 'keycloak']) {
  const cases = JSON.parse(await download(`offline/golden_comments/${project}.json`));
  for (const item of cases) {
    const match = /^https:\/\/github.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(item.url);
    if (!match) throw new Error('invalid benchmark PR reference');
    const repository = match[1],
      number = Number(match[2]);
    const id = `${project}-${number}`;
    if (++visited > limit || manifest.some((item) => item.id === id)) continue;
    const pr = await client.getPullRequest(repository, number);
    const snapshot = await client.snapshotDiff(repository, pr);
    const context = await retrieveContext(
      snapshot.diff.text,
      client.repositoryReader(repository, pr.head.sha),
      parseRepositoryConfig(undefined),
    );
    const directory = resolve(output, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(directory, 'change.diff'), snapshot.diff.bytes);
    writeFileSync(
      resolve(directory, 'context.json'),
      JSON.stringify(Object.fromEntries(context.files.map((file) => [file.path, file.content]))),
    );
    // Scoring labels live separately and are never loaded by the review pipeline.
    writeFileSync(resolve(directory, 'gold.json'), JSON.stringify(item.comments, null, 2));
    manifest.push({
      id,
      url: item.url,
      annotationRevision: revision,
      ...snapshot.binding,
      contextSha256: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
      annotations: item.comments.length,
    });
    writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Frozen ${id}`);
  }
}
console.log(
  `Imported ${manifest.length} PRs. Use --dataset external with compare-pipeline.mjs, then adjudicate findings against gold.json.`,
);
