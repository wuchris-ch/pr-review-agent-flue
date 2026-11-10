#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gatewayConfig } from '../agents/gateway.js';
import { isMainModule } from '../cli/harness.js';
import { indexDiff } from '../core/diff/parse.js';
import {
  type ChangedFile,
  type ChatModel,
  COMMENT_MARKER,
  findStaleDocs,
  gatewayChatModel,
  renderStaleDocsReport,
} from '../docs/stale-docs.js';
import { GitHubClient } from '../github/client.js';

const USAGE =
  'Usage: stale-docs --base <git ref> [--repo <owner/name> --pr <number>] <documentation files...>';

export const SKIPPED_MESSAGE =
  'Stale documentation check skipped: no model endpoint is configured. Set MODEL_GATEWAY_API_KEY, MODEL_GATEWAY_BASE_URL and REVIEW_AGENT_MODEL to enable it.';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Text files changed between the merge base of <base> and HEAD, with their diffs. */
function changedTextFiles(base: string): ChangedFile[] {
  const range = `${base}...HEAD`;
  // Binary files report "-" for their line counts and have no text diff to show the model.
  const textPaths = git(['diff', '--no-renames', '--numstat', '-z', range])
    .split('\0')
    .filter((entry) => entry && !entry.startsWith('-\t-\t'))
    .map((entry) => entry.split('\t').slice(2).join('\t'));
  if (!textPaths.length) {
    return [];
  }
  const diff = git(['diff', '--no-renames', '--no-ext-diff', range, '--', ...textPaths]);
  return indexDiff(diff).map((file) => ({ path: file.path, patch: file.text }));
}

interface IssueComment {
  id: number;
  body?: string;
}

/**
 * Keep one comment per pull request up to date.
 *
 * A clean result only updates an earlier comment, so pull requests that never
 * had stale pages get no comment at all.
 */
async function publishComment(
  client: GitHubClient,
  repository: string,
  number: number,
  body: string,
  hasFlags: boolean,
): Promise<void> {
  const comments = await client.request<IssueComment[]>(
    `/repos/${repository}/issues/${number}/comments?per_page=100`,
  );
  const existing = comments.find((comment) => comment.body?.startsWith(COMMENT_MARKER));
  const options = { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ body }) };
  if (existing) {
    await client.request(`/repos/${repository}/issues/comments/${existing.id}`, options);
  } else if (hasFlags) {
    await client.request(`/repos/${repository}/issues/${number}/comments`, options);
  }
}

export async function runStaleDocs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  model?: ChatModel,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'string' } },
  });
  const report = (text: string): void => {
    process.stdout.write(`${text}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  if (!values.base || !positionals.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const configured =
    env.MODEL_GATEWAY_API_KEY?.trim() &&
    env.MODEL_GATEWAY_BASE_URL?.trim() &&
    env.REVIEW_AGENT_MODEL?.trim();
  if (!model && !configured) {
    report(SKIPPED_MESSAGE);
    return 0;
  }
  const pages = positionals.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  const result = await findStaleDocs(
    changedTextFiles(values.base),
    pages,
    model ?? gatewayChatModel(gatewayConfig(env)),
  );
  const body = renderStaleDocsReport(result);
  report(body);
  if (values.repo && values.pr && env.GITHUB_TOKEN) {
    await publishComment(
      new GitHubClient(env.GITHUB_TOKEN),
      values.repo,
      Number(values.pr),
      body,
      result.flags.length > 0,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url))
  runStaleDocs(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Gateway and GitHub errors are already reduced to non-sensitive messages.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Stale documentation check failed: ${message}\n`);
      process.exitCode = 1;
    });
