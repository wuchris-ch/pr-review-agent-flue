import { describe, expect, it, vi } from 'vitest';
import { parseAgentArgs } from '../../src/cli/commands/agent.js';
import { type InputReader, localSource } from '../../src/sources/local.js';

const diffText = 'diff --git a/a.ts b/a.ts\n+fixed';

function reader(): InputReader {
  return {
    readFile: vi.fn(() => Buffer.from(diffText)),
    readStdin: vi.fn(() => Buffer.from('diff --git a/b.ts b/b.ts\n+safe')),
  };
}

describe('local diff source', () => {
  it('reads from stdin when no path is supplied', async () => {
    const input = reader();
    const { diff, label } = await localSource({ reader: input }).fetch();

    expect(diff.text).toContain('b/b.ts');
    expect(label).toBe('stdin');
    expect(input.readStdin).toHaveBeenCalledOnce();
  });

  it('reads the supplied diff path', async () => {
    const input = reader();
    const { diff } = await localSource({ diffPath: 'change.diff', reader: input }).fetch();

    expect(diff.text).toContain('a/a.ts');
    expect(input.readFile).toHaveBeenCalledWith('change.diff');
  });

  it('reads optional repository instructions', async () => {
    const input = reader();
    vi.mocked(input.readFile).mockImplementation((path) =>
      Buffer.from(path === 'AGENTS.md' ? 'Prioritize authorization.' : diffText),
    );

    const request = await localSource({
      diffPath: 'change.diff',
      instructionsPath: 'AGENTS.md',
      reader: input,
    }).fetch();

    expect(request.diff.text).toBe(diffText);
    expect(request.instructions).toBe('Prioritize authorization.');
  });

  it('surfaces empty input as a clear error', async () => {
    await expect(
      localSource({
        reader: { readFile: () => Buffer.alloc(0), readStdin: () => Buffer.from('   ') },
      }).fetch(),
    ).rejects.toThrow(/must not be empty/);
  });
});

describe('agent argument parsing', () => {
  it('accepts either argument order', () => {
    expect(parseAgentArgs(['--instructions', 'AGENTS.md', '--diff', 'change.diff'])).toEqual({
      diffPath: 'change.diff',
      instructionsPath: 'AGENTS.md',
    });
  });

  it('rejects unknown options and repeated flags', () => {
    expect(() => parseAgentArgs(['--unknown'])).toThrow(/usage/);
    expect(() => parseAgentArgs(['--diff', 'a', '--diff', 'b'])).toThrow(/only once/);
  });
});
