import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProcess } from '../../src/agents/executor.js';
import {
  type ExploreAsk,
  exploreRepository,
  locateSymbol,
  parseExplorationReply,
} from '../../src/context/explore.js';
import { gitReader, parseGrepOutput, type RepositoryReader } from '../../src/context/repository.js';
import { Deadline } from '../../src/core/deadline.js';
import { decodeDiff } from '../../src/core/input.js';
import { parseRepositoryConfig, type RepositoryConfig } from '../../src/core/repository-config.js';
import { reviewDiffDetailed } from '../../src/review-service.js';
import { cleanReview } from '../helpers.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** A small committed repository: a cache class, a caller, a secret file and generated code. */
function repository(): RepositoryReader {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-explore-'));
  directories.push(root);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.com');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'generated'));
  writeFileSync(
    join(root, 'src/cache.ts'),
    [
      "import { db } from './db';",
      '',
      'export class OrderCache {',
      '  async loadOrders(tenant: string) {',
      '    return db.orders(tenant);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src/service.ts'),
    "export const service = (cache) => cache.loadOrders('1');\n",
  );
  writeFileSync(join(root, '.env'), 'SECRET=loadOrders\n');
  writeFileSync(join(root, 'generated/client.ts'), 'export const loadOrders = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  return gitReader(root, git(root, 'rev-parse', 'HEAD'));
}

const diff = decodeDiff(
  Buffer.from(
    [
      'diff --git a/src/service.ts b/src/service.ts',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -1 +1 @@',
      "-export const service = (cache) => cache.loadOrders('1');",
      '+export const service = (cache) => cache.loadOrders(1);',
      '',
    ].join('\n'),
  ),
);

const reply = (body: unknown): AgentProcess => ({
  status: 0,
  stdout: JSON.stringify(body),
  stderr: '',
});
const finished = reply({ lookups: [], done: true });

function explore(
  reader: RepositoryReader,
  ask: ExploreAsk,
  config: RepositoryConfig = parseRepositoryConfig(undefined),
) {
  return exploreRepository({
    diff: diff.text,
    diffSha256: diff.sha256,
    reader,
    config,
    ask,
    deadline: Deadline.in(60_000),
    callTimeoutMs: 10_000,
  });
}

describe('context exploration', () => {
  it('answers searches, then keeps the excerpts the model read', async () => {
    const ask = vi
      .fn<ExploreAsk>()
      .mockResolvedValueOnce(reply({ lookups: [{ kind: 'search', text: 'loadOrders' }] }))
      .mockResolvedValueOnce(
        reply({
          lookups: [{ kind: 'read', path: 'src/cache.ts', symbol: 'loadOrders' }],
          done: true,
        }),
      );

    const result = await explore(repository(), ask);

    expect(ask.mock.calls[0]![0]).toContain('Changed files:\n- src/service.ts');
    expect(ask.mock.calls[1]![0]).toContain('src/cache.ts:4: async loadOrders(tenant: string) {');
    expect(result).toMatchObject({ searches: 1, reads: 1, rounds: 2, stopped: 'done' });
    expect(result.files).toEqual([expect.objectContaining({ path: 'src/cache.ts', focus: [3] })]);
  });

  it('rejects unsafe, sensitive and excluded paths without reading them', async () => {
    const ask = vi
      .fn<ExploreAsk>()
      .mockResolvedValueOnce(
        reply({
          lookups: [
            { kind: 'read', path: '../outside.ts' },
            { kind: 'read', path: '.env' },
            { kind: 'read', path: 'generated/client.ts' },
            { kind: 'search', text: 'loadOrders' },
          ],
        }),
      )
      .mockResolvedValue(finished);
    const config = parseRepositoryConfig(JSON.stringify({ version: 1, exclude: ['generated/**'] }));

    const result = await explore(repository(), ask, config);

    const echoed = ask.mock.calls[1]![0];
    expect(echoed.match(/rejected path/g)).toHaveLength(3);
    expect(echoed).toContain('src/cache.ts:4:');
    expect(echoed).not.toContain('generated/client.ts:1');
    expect(echoed).not.toContain('SECRET');
    expect(result).toMatchObject({ reads: 0, files: [] });
  });

  it('bounds lookups per round and stops when the model repeats itself', async () => {
    const many = Array.from({ length: 20 }, (_, n) => ({ kind: 'search', text: `term${n}` }));
    const ask = vi.fn<ExploreAsk>().mockResolvedValue(reply({ lookups: many }));

    const result = await explore(repository(), ask);

    expect(result).toMatchObject({ searches: 8, rounds: 2, stopped: 'no-lookups' });
  });

  it('ends exploration, not the review, when the model fails or replies badly', async () => {
    const reader = repository();
    const failing = vi.fn<ExploreAsk>().mockResolvedValue({ status: 1, stdout: '', stderr: '' });
    const malformed = vi
      .fn<ExploreAsk>()
      .mockResolvedValue({ status: 0, stdout: 'search for it', stderr: '' });

    expect(await explore(reader, failing)).toMatchObject({ stopped: 'model', files: [] });
    expect(await explore(reader, malformed)).toMatchObject({ stopped: 'invalid', files: [] });
  });

  it('reads without searching when the repository cannot be searched', async () => {
    const reader = repository();
    const readOnly: RepositoryReader = {
      revision: reader.revision,
      paths: () => reader.paths(),
      read: (path, maxBytes) => reader.read(path, maxBytes),
    };
    const ask = vi
      .fn<ExploreAsk>()
      .mockResolvedValueOnce(
        reply({
          lookups: [
            { kind: 'search', text: 'loadOrders' },
            { kind: 'read', path: 'src/cache.ts', line: 5 },
          ],
        }),
      )
      .mockResolvedValue(finished);

    const result = await explore(readOnly, ask);

    expect(ask.mock.calls[0]![0]).toContain('read only');
    expect(ask.mock.calls[1]![0]).toContain('search is unavailable');
    expect(result).toMatchObject({ searches: 0, reads: 1 });
    expect(result.files[0]?.focus).toEqual([4]);
  });

  it('parses replies leniently and locates definitions before uses', () => {
    expect(
      parseExplorationReply(
        JSON.stringify({
          lookups: [
            { kind: 'run', command: 'ls' },
            { kind: 'read', path: 'a.ts' },
          ],
        }),
        8,
      ),
    ).toEqual({ lookups: [{ kind: 'read', path: 'a.ts' }], done: false });
    expect(() => parseExplorationReply('lookups: []', 8)).toThrow();
    expect(locateSymbol(['use(loadOrders)', 'function loadOrders() {}'], 'loadOrders')).toBe(1);
    expect(locateSymbol(['cache.get(key)'], 'get(key')).toBe(0);
    expect(locateSymbol(['loadOrdersLater()'], 'loadOrders')).toBeUndefined();
  });

  it('parses git grep rows and drops unsafe paths', () => {
    const revision = 'a'.repeat(40);
    const output = [
      `${revision}:src/a.ts:3:  const value = 1;`,
      `${revision}:node_modules/x/index.js:1:value`,
      `${revision}:src/b.ts:10:value: 2`,
    ].join('\n');

    expect(parseGrepOutput(output, revision, 5)).toEqual([
      { path: 'src/a.ts', line: 3, text: '  const value = 1;' },
      { path: 'src/b.ts', line: 10, text: 'value: 2' },
    ]);
    expect(parseGrepOutput(output, revision, 1)).toHaveLength(1);
  });

  it('gives the reviewer explored excerpts as read-only, citable context', async () => {
    const messages: string[] = [];
    const execute = vi.fn(async (message: string) => {
      messages.push(message);
      return { status: 0, stdout: JSON.stringify(cleanReview(diff.sha256)), stderr: '' };
    });
    const exploreExecute = vi.fn().mockResolvedValueOnce(
      reply({
        lookups: [{ kind: 'read', path: 'src/cache.ts', symbol: 'loadOrders' }],
        done: true,
      }),
    );

    const result = await reviewDiffDetailed(diff, {
      execute,
      exploreExecute,
      explorationReader: repository(),
      repositoryConfig: { ...parseRepositoryConfig(undefined), validateFindings: false },
      config: { huntEnabled: false, verifyEnabled: false },
    });

    expect(messages[0]).toContain('Repository context "src/cache.ts"');
    expect(messages[0]).toMatch(/\[R\d+N4\] {3}async loadOrders\(tenant: string\) \{/);
    expect(result.review.rationale).toContain('Exploration: 0 searches and 1 reads over 1 rounds');
  });

  it('still reviews when exploration fails', async () => {
    const execute = vi.fn(async () => ({
      status: 0,
      stdout: JSON.stringify(cleanReview(diff.sha256)),
      stderr: '',
    }));

    const result = await reviewDiffDetailed(diff, {
      execute,
      exploreExecute: vi.fn().mockResolvedValue({ status: 1, stdout: '', stderr: '' }),
      explorationReader: repository(),
      repositoryConfig: { ...parseRepositoryConfig(undefined), validateFindings: false },
      config: { huntEnabled: false, verifyEnabled: false },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.review.findings).toEqual([]);
    expect(result.review.rationale).toContain('added 0 files (model)');
  });
});
