#!/usr/bin/env node
// Turn saved agent answers into ReviewBench findings files.
//
// Pool mode writes every finding of every run of one kind, plus an index that says which run each
// finding came from. judge.ts matches the pool to the golden findings once; analyze.py then
// composes reviews from it without another model call.
//
//   node evals/reviewbench/findings.mjs --answers <answers dir> --out <pool dir> [--runs 1,2,3] [--work <dir>]
//
// Engine mode writes what integrations/reviewbench/adapter.mjs writes for one configuration: the
// saved answers go through the engine's own merging, with one pass per lens=dir:run entry.
//
//   node evals/reviewbench/findings.mjs --engine bugs=<answers dir>:1,breadth=<answers dir>:1 --out <dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAgentFindings } from '../../dist/agents/agent-reviewer.js';
import { reviewPullRequest } from '../../integrations/reviewbench/review-pull-request.mjs';

const options = { work: join(homedir(), '.cache/pr-review-reviewbench'), runs: '1' };
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.out || (!options.answers && !options.engine))
  throw new Error('usage: findings.mjs --answers <dir> --out <dir> [--runs 1,2,3] | --engine lens=dir:run,... --out <dir>');
mkdirSync(join(options.out, 'findings'), { recursive: true });
const keys = readdirSync(join(options.work, 'pr')).sort();
const pullRequest = (key) => {
  const pr = JSON.parse(readFileSync(join(options.work, 'pr', key, 'pr.json'), 'utf8'));
  return { repo: pr.repo, pr_number: pr.pr_number, base: pr.base, head: pr.head };
};
const write = (key, agent, findings) =>
  writeFileSync(join(options.out, 'findings', key + '.json'), JSON.stringify({ pr: pullRequest(key), agent, findings }, null, 1));
let total = 0;

if (options.engine) {
  const passes = options.engine.split(',').map((entry) => {
    const [lens, rest] = [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)];
    return { lens, directory: rest.slice(0, rest.lastIndexOf(':')), run: rest.slice(rest.lastIndexOf(':') + 1) };
  });
  let reviewed = 0;
  let notIndexed = 0;
  for (const key of keys) {
    const answers = passes.map((pass) => ({ lens: pass.lens, path: join(pass.directory, key + '-' + pass.run + '.md') }));
    if (!answers.every((answer) => existsSync(answer.path))) continue;
    const review = await reviewPullRequest({
      diffBytes: readFileSync(join(options.work, 'pr', key, 'diff.patch')),
      repo: join(options.work, 'repos', key),
      validate: false,
      grounding: options.grounding ?? 'off',
      passes: passes.map((pass) => pass.lens),
      // The passes start in order, so each call takes the next answer of its lens.
      run: async (lens) => readFileSync(answers.splice(answers.findIndex((answer) => answer.lens === lens), 1)[0].path, 'utf8'),
    });
    const findings = review.findings.map((finding) => ({ producer: 'engine', file: finding.file, start_line: finding.line, end_line: finding.line, message: finding.message }));
    total += findings.length;
    reviewed += 1;
    notIndexed += review.notIndexed ? 1 : 0;
    write(key, 'engine', findings);
  }
  console.log(total + ' findings for ' + reviewed + ' of ' + keys.length + ' pull requests written to ' + options.out + '; the engine did not index ' + notIndexed);
} else {
  const runs = options.runs.split(',').map(Number);
  const index = {};
  const reviews = {};
  for (const key of keys) {
    const findings = [];
    index[key] = [];
    reviews[key] = {};
    for (const run of runs) {
      const answer = join(options.answers, key + '-' + run + '.md');
      if (!existsSync(answer)) continue;
      const meta = join(options.answers, key + '-' + run + '.meta.json');
      const { costUsd, wallMs } = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) : {};
      reviews[key][run] = { costUsd: costUsd ?? null, wallMs: wallMs ?? null };
      for (const finding of parseAgentFindings(readFileSync(answer, 'utf8'), join(options.work, 'repos', key))) {
        findings.push({
          producer: 'run-' + run,
          file: finding.file,
          start_line: finding.line,
          end_line: finding.line,
          message: finding.body ? finding.title + '. ' + finding.body : finding.title,
        });
        index[key].push({ run, priority: finding.priority, file: finding.file, line: finding.line, title: finding.title, chars: finding.title.length + finding.body.length });
      }
    }
    total += findings.length;
    write(key, 'pool', findings);
  }
  writeFileSync(join(options.out, 'index.json'), JSON.stringify({ runs, reviews, findings: index }));
  console.log(total + ' findings from runs ' + runs.join(',') + ' written to ' + options.out);
}
