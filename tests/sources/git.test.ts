import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitSource } from '../../src/sources/git.js';

const review = (cwd: string, base?: string) =>
  gitSource({ cwd, ...(base === undefined ? {} : { base }) }).fetch();

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pr-review-command-'));
  temporaryDirectories.push(directory);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Test User');
  git(directory, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(directory, 'app.ts'), 'export const value = 1;\n');
  git(directory, 'add', 'app.ts');
  git(directory, 'commit', '-m', 'initial');
  git(directory, 'switch', '-c', 'feature');
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('local Git diff source', () => {
  it('collects committed and working-tree changes from the branch base', async () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');

    const input = await review(directory);

    expect(input.diff.text).toContain('-export const value = 1;');
    expect(input.diff.text).toContain('+export const value = 2;');
    expect(input.label).toContain('...HEAD');
  });

  it('automatically loads root AGENTS.md guidance', async () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');
    writeFileSync(join(directory, 'AGENTS.md'), 'Prioritize authorization.\n');

    expect((await review(directory)).instructions).toBe('Prioritize authorization.\n');
  });

  it('reports an empty branch clearly', async () => {
    const directory = repository();
    await expect(review(directory)).rejects.toThrow(/no changes to review/);
  });

  it('accepts an explicit base ref and rejects a missing one', async () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');

    expect((await review(directory, 'main')).diff.text).toContain('+export const value = 2;');
    await expect(review(directory, 'missing')).rejects.toThrow(/does not exist/);
  });
});
