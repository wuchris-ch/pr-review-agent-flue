#!/usr/bin/env node
// Review prepared ReviewBench checkouts with the agent reviewer and keep each answer with the cost
// and duration Claude Code reports. The prompts are the engine's own; the command line mirrors
// src/agents/agent-reviewer.ts and adds nothing but the cost record. Saved answers are reused.
//
//   node evals/reviewbench/review.mjs --out <answers dir> [--lens bugs|breadth] [--runs 1]
//     [--model claude-opus-5-5] [--effort high] [--concurrency 2] [--work <dir>] [--only key,key]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentBreadthPrompt, agentReviewPrompt } from '../../dist/agents/agent-reviewer.js';

const options = { work: join(homedir(), '.cache/pr-review-reviewbench'), lens: 'bugs', runs: '1', model: 'claude-opus-5-5', effort: 'high', concurrency: '2', timeout: '780', only: '' };
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.out || !['bugs', 'breadth'].includes(options.lens)) throw new Error('usage: review.mjs --out <dir> [--lens bugs|breadth] [--runs N]');
const only = options.only.split(',').filter(Boolean);
mkdirSync(options.out, { recursive: true });

function review(key) {
  const pr = JSON.parse(readFileSync(join(options.work, 'pr', key, 'pr.json'), 'utf8'));
  const prompt = (options.lens === 'breadth' ? agentBreadthPrompt : agentReviewPrompt)(
    'The repository is checked out at the pull request head; the base commit is ' + pr.base + '.',
    'git diff ' + pr.base + '...' + pr.head,
  );
  const args = ['-p', prompt, '--model', options.model, '--effort', options.effort, '--safe-mode', '--tools', 'Read,Grep,Glob,Bash',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
    'Bash(git status:*)', 'Bash(git grep:*)', 'Bash(git ls-files:*)', '--permission-prompts', 'none',
    '--output-format', 'json', '--no-session-persistence'];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd: join(options.work, 'repos', key), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(options.timeout) * 1000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      try {
        const parsed = JSON.parse(stdout);
        const result = (Array.isArray(parsed) ? parsed : [parsed]).reverse().find((event) => event?.type === 'result');
        if (code === 0 && result && result.is_error !== true && typeof result.result === 'string')
          return resolve({ ok: true, text: result.result, meta: { wallMs, costUsd: result.total_cost_usd, turns: result.num_turns, usage: result.usage } });
        resolve({ ok: false, error: 'exit ' + code + ' ' + String(result?.result ?? stderr).slice(0, 300) });
      } catch {
        resolve({ ok: false, error: 'exit ' + code + ' unreadable output ' + stderr.slice(-300) });
      }
    });
    child.stdin.end('');
  });
}

const tasks = [];
for (const key of readdirSync(join(options.work, 'pr')).sort())
  if (only.length === 0 || only.includes(key))
    for (let run = 1; run <= Number(options.runs); run++)
      if (!existsSync(join(options.out, key + '-' + run + '.md'))) tasks.push({ key, run });
console.log(tasks.length + ' reviews to run, model ' + options.model + ' effort ' + options.effort + ' lens ' + options.lens);
let next = 0;
let failed = 0;
const pause = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
async function worker() {
  while (next < tasks.length) {
    const { key, run } = tasks[next++];
    let result = await review(key);
    // A failed review is usually a rate limit; wait before each of two more tries.
    for (const seconds of [60, 180]) {
      if (result.ok) break;
      console.log(key + '-' + run + ': retry in ' + seconds + 's after ' + result.error.slice(0, 80));
      await pause(seconds);
      result = await review(key);
    }
    if (result.ok) {
      writeFileSync(join(options.out, key + '-' + run + '.md'), result.text);
      writeFileSync(join(options.out, key + '-' + run + '.meta.json'), JSON.stringify(result.meta));
      console.log(key + '-' + run + ': ok ' + Math.round(result.meta.wallMs / 1000) + 's $' + Number(result.meta.costUsd ?? 0).toFixed(2));
    } else {
      failed++;
      console.log(key + '-' + run + ': FAILED ' + result.error);
    }
  }
}
await Promise.all(Array.from({ length: Number(options.concurrency) }, worker));
console.log('done, failed ' + failed);
