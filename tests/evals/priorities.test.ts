import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../evals/priorities/', import.meta.url);

function execute(fixture: string, script: string): unknown {
  const module = new URL(fixture, root).href;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const fixture = await import(${JSON.stringify(module)});\n${script}`,
      ],
      { encoding: 'utf8' },
    ),
  );
}

describe('repository-priority fixtures', () => {
  it.each(['batch', 'retry'])('keeps the %s diff identical to the executable change', (name) => {
    const directory = mkdtempSync(join(tmpdir(), 'review-priority-'));
    try {
      const file = name === 'batch' ? 'batch.mjs' : 'delivery.mjs';
      const base = readFileSync(new URL(`${name}/base.mjs`, root), 'utf8');
      writeFileSync(join(directory, file), base);
      execFileSync('git', ['apply', fileURLToPath(new URL(`${name}/change.diff`, root))], {
        cwd: directory,
      });
      expect(readFileSync(join(directory, file), 'utf8')).toBe(
        readFileSync(new URL(`${name}/head.mjs`, root), 'utf8'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['base', 100, 20],
    ['head', 100, 100],
    ['base', 4, 4],
    ['head', 4, 4],
  ])('measures %s concurrency with %i inputs', (side, size, peak) => {
    expect(
      execute(
        `batch/${side}.mjs`,
        `
      let active = 0, peak = 0;
      const ids = Array.from({ length: ${size} }, (_, i) => i);
      const result = await fixture.loadBatch(ids, async (id) => {
        peak = Math.max(peak, ++active);
        await new Promise(setImmediate);
        active--;
        return id;
      });
      console.log(JSON.stringify({ peak, preservesOrder: JSON.stringify(result) === JSON.stringify(ids) }));
    `,
      ),
    ).toEqual({ peak, preservesOrder: true });
  });

  it.each([
    ['base', false, 1, true],
    ['head', false, 2, false],
    ['base', true, 1, true],
    ['head', true, 1, false],
  ])('checks %s delivery with idempotency=%s', (side, deduplicate, effects, uncertain) => {
    expect(
      execute(
        `retry/${side}.mjs`,
        `
      let calls = 0, effects = 0, uncertain = false;
      const accepted = new Set();
      const event = Object.freeze({ id: 'event-1', payload: -1 });
      try {
        await fixture.deliver(event, async (id) => {
          calls++;
          if (!${deduplicate} || !accepted.has(id)) effects++;
          accepted.add(id);
          if (calls === 1) throw Object.assign(new Error('Acknowledgement lost'), { code: 'ETIMEDOUT' });
        });
      } catch { uncertain = true; }
      console.log(JSON.stringify({ effects, uncertain }));
    `,
      ),
    ).toEqual({ effects, uncertain });
  });
});
