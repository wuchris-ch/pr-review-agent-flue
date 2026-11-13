#!/usr/bin/env node
// ReviewBench adapter: reviews one mounted pull request with the agent reviewer and
// writes the contract's findings file. See README.md in this directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { runAgentReviewer } from '../../dist/agents/agent-reviewer.js';
import { gitReader, retrieveContext } from '../../dist/context/repository.js';
import { decodeDiff } from '../../dist/core/input.js';
import { DEFAULT_REPOSITORY_CONFIG } from '../../dist/core/repository-config.js';
import { reviewPullRequest } from './review-pull-request.mjs';

const env = process.env;
const required = (name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const repo = env.RB_REPO_DIR || '/work/repo';
const base = required('RB_BASE');
const head = required('RB_HEAD');
const agent = required('RB_AGENT');
const prNumber = Number(required('RB_PR_NUMBER'));
const cli = env.RB_CONFIG_CLI || 'claude';
const model = env.RB_CONFIG_MODEL || (cli === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol');
const breadthModel = env.RB_CONFIG_BREADTH_MODEL || model;
const effort = env.RB_CONFIG_EFFORT || env.RB_CONFIG_REASONING || 'high';
const validate = ['1', 'on', 'true', 'yes'].includes((env.RB_CONFIG_VALIDATE || 'off').toLowerCase());
const count = (name, fallback, minimum, maximum) => {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};
const runs = count('RB_CONFIG_RUNS', 1, 1, 5);
const breadthRuns = count('RB_CONFIG_BREADTH_RUNS', 0, 0, 3);
// ReviewBench matches findings by file, so the agent's own line is kept by default.
// `exact` keeps only findings on a line the change edits, as the GitHub publisher does.
const grounding = env.RB_CONFIG_GROUNDING || 'off';
if (!['off', 'exact'].includes(grounding)) throw new Error('RB_CONFIG_GROUNDING must be off or exact');
console.log(
  `cli=${cli} model=${model} effort=${effort} runs=${runs} breadth_runs=${breadthRuns} breadth_model=${breadthModel} grounding=${grounding} validate=${validate ? 'on' : 'off'}`,
);

const diffBytes = readFileSync(env.RB_DIFF || '/work/pr/diff.patch');
const review = await reviewPullRequest({
  diffBytes,
  repo,
  validate,
  grounding,
  passes: [...Array(runs).fill('bugs'), ...Array(breadthRuns).fill('breadth')],
  ...(validate
    ? {
        repositoryContext: () =>
          retrieveContext(decodeDiff(diffBytes).text, gitReader(repo, head), DEFAULT_REPOSITORY_CONFIG),
      }
    : {}),
  run: (lens) =>
    runAgentReviewer({
      cli,
      cwd: repo,
      description: `The repository is checked out at the pull request head; the base commit is ${base}.`,
      diffCommand: `git diff ${base}...${head}`,
      model: lens === 'breadth' ? breadthModel : model,
      effort,
      lens,
      timeoutMs: Number(env.RB_CONFIG_TIMEOUT_SECONDS || 780) * 1000,
    }),
});
if (review.notIndexed)
  console.log(`the engine did not index this diff (${review.notIndexed}); findings keep the agent's locations`);
const findings = review.findings.map((finding) => ({
  file: finding.file,
  start_line: finding.line,
  end_line: finding.line,
  message: finding.message,
  producer: agent,
}));
writeFileSync(
  env.RB_OUT || '/work/out/findings.json',
  `${JSON.stringify(
    {
      pr: { repo: `https://github.com/${required('RB_NWO')}`, pr_number: prNumber, base, head },
      agent,
      findings,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${String(findings.length)} findings`);

