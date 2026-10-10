#!/usr/bin/env node
// ReviewBench adapter: reviews one mounted pull request with the agent reviewer and
// writes the contract's findings file. See README.md in this directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { runAgentReviewer } from '../../dist/agents/agent-reviewer.js';
import { gitReader, retrieveContext } from '../../dist/context/repository.js';
import { decodeDiff } from '../../dist/core/input.js';
import { DEFAULT_REPOSITORY_CONFIG } from '../../dist/core/repository-config.js';
import { reviewDiffDetailed } from '../../dist/review-service.js';

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
const effort = env.RB_CONFIG_EFFORT || env.RB_CONFIG_REASONING || 'high';
const validate = ['1', 'on', 'true', 'yes'].includes((env.RB_CONFIG_VALIDATE || 'off').toLowerCase());
console.log(`cli=${cli} model=${model} effort=${effort} validate=${validate ? 'on' : 'off'}`);

const diff = decodeDiff(readFileSync(env.RB_DIFF || '/work/pr/diff.patch'));
const repositoryContext = validate
  ? await retrieveContext(diff.text, gitReader(repo, head), DEFAULT_REPOSITORY_CONFIG)
  : undefined;
const result = await reviewDiffDetailed(diff, {
  repositoryConfig: { ...DEFAULT_REPOSITORY_CONFIG, validateFindings: validate },
  ...(repositoryContext ? { repositoryContext } : {}),
  agentReview: {
    root: repo,
    validate,
    run: () =>
      runAgentReviewer({
        cli,
        cwd: repo,
        description: `The repository is checked out at the pull request head; the base commit is ${base}.`,
        diffCommand: `git diff ${base}...${head}`,
        model,
        effort,
        timeoutMs: Number(env.RB_CONFIG_TIMEOUT_SECONDS || 780) * 1000,
      }),
  },
});
const findings = result.review.findings.map((finding) => ({
  file: finding.file,
  start_line: finding.line,
  end_line: finding.line,
  message: finding.detail,
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

