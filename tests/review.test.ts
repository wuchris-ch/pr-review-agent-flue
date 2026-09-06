import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readCurrentReviewInput } from '../src/review.js';

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

describe('simple review command', () => {
  it('collects committed and working-tree changes from the branch base', () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');

    const input = readCurrentReviewInput(directory);

    expect(input.diff.text).toContain('-export const value = 1;');
    expect(input.diff.text).toContain('+export const value = 2;');
  });

  it('automatically loads root AGENTS.md guidance', () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');
    writeFileSync(join(directory, 'AGENTS.md'), 'Prioritize authorization.\n');

    expect(readCurrentReviewInput(directory).instructions).toBe(
      'Prioritize authorization.\n',
    );
  });

  it('reports an empty branch clearly', () => {
    const directory = repository();
    expect(() => readCurrentReviewInput(directory)).toThrow(
      /no changes to review/,
    );
  });

  it('accepts an explicit base ref and rejects a missing one', () => {
    const directory = repository();
    writeFileSync(join(directory, 'app.ts'), 'export const value = 2;\n');

    expect(readCurrentReviewInput(directory, 'main').diff.text).toContain(
      '+export const value = 2;',
    );
    expect(() => readCurrentReviewInput(directory, 'missing')).toThrow(
      /does not exist/,
    );
  });
});
