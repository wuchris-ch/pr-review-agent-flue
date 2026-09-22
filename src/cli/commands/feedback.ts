import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReview } from '../../core/schema.js';
import { findingKey } from '../../github/inline.js';
import type { Command } from '../harness.js';

function boundedJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('feedback input exceeds 2 MiB');
  return JSON.parse(bytes.toString('utf8'));
}

export const feedbackCommand: Command = {
  name: 'feedback',
  summary: 'Record useful or false-positive findings for evaluation.',
  usage:
    'usage: pr-review feedback --review <json> --finding <1-based-index> --decision useful|false-positive --reason <text> | --summary',
  async run(args, { cwd, io }) {
    const directory = join(cwd, '.pr-review');
    const path = join(directory, 'feedback.jsonl');
    if (args.length === 1 && args[0] === '--summary') {
      const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
      if (bytes.length > 2 * 1024 * 1024)
        throw new Error('feedback log exceeds 2 MiB; archive older entries');
      const rows = bytes
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      // Latest decision per exact finding and input; repetitions cannot inflate acceptance rates.
      const latest = [...new Map(rows.map((row) => [`${row.input}:${row.finding}`, row])).values()];
      io.stdout(
        `${JSON.stringify({ reviewedFindings: latest.length, useful: latest.filter((row) => row.decision === 'useful').length, falsePositives: latest.filter((row) => row.decision === 'false-positive').map((row) => ({ file: row.file, reason: row.reason })), nextStep: 'Review repeated false-positive reasons and add narrowly scoped rules to .pr-review.json. Feedback never automatically suppresses findings.' }, null, 2)}\n`,
      );
      return 0;
    }
    const values = new Map<string, string>();
    for (let n = 0; n < args.length; n += 2) {
      const flag = args[n]!;
      if (
        !['--review', '--finding', '--decision', '--reason'].includes(flag) ||
        !args[n + 1] ||
        values.has(flag)
      )
        throw new Error(this.usage);
      values.set(flag, args[n + 1]!);
    }
    if (values.size !== 4) throw new Error(this.usage);
    const review = validateReview(boundedJson(values.get('--review')!));
    const index = Number(values.get('--finding'));
    const finding = review.findings[index - 1];
    const decision = values.get('--decision')!;
    const reason = values.get('--reason')!.trim();
    if (
      !Number.isSafeInteger(index) ||
      !finding ||
      !['useful', 'false-positive'].includes(decision) ||
      !reason ||
      reason.length > 2000
    )
      throw new Error(this.usage);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(
      path,
      `${JSON.stringify({ version: 1, at: new Date().toISOString(), input: review.input_sha256, finding: findingKey(finding), file: finding.file, decision, reason })}\n`,
      { mode: 0o600 },
    );
    io.stdout('Feedback recorded locally. Run pr-review feedback --summary to inspect it.\n');
    return 0;
  },
};
