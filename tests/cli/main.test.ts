import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/harness.js';
import { COMMANDS, findCommand, runCli } from '../../src/cli/main.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('command registry', () => {
  it('registers every documented command exactly once', () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(['review', 'pr', 'agent', 'watch']);
    expect(new Set(COMMANDS.map((command) => command.name)).size).toBe(COMMANDS.length);
    for (const command of COMMANDS) {
      expect(findCommand(command.name)).toBe(command);
    }
  });

  it('prints help without a command and lists each summary', async () => {
    const io = capture();
    expect(await runCli([], io.io)).toBe(EXIT_OK);
    for (const command of COMMANDS) {
      expect(io.out()).toContain(command.summary);
    }
  });

  it('reports an unknown command instead of guessing', async () => {
    const io = capture();
    expect(await runCli(['reveiw'], io.io)).toBe(EXIT_FAILED);
    expect(io.err()).toContain('unknown command: reveiw');
  });

  it('turns a thrown error into one stable failure line on stderr', async () => {
    const io = capture();
    expect(await runCli(['pr', '--not-a-flag'], io.io, '/workspace')).toBe(EXIT_FAILED);
    expect(io.err()).toMatch(/^review failed: usage: /);
    expect(io.out()).toBe('');
  });

  it('keeps the --pr alias on the default review command', async () => {
    const io = capture();
    // Routed to the pull-request parser, so it fails on PR usage, not review usage.
    expect(await runCli(['review', '--pr', 'not-a-pr'], io.io, '/workspace')).toBe(EXIT_FAILED);
    expect(io.err()).toContain('pr-review-pr');
  });
});
