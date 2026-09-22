#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainModule } from '../cli/harness.js';
import { GitHubClient } from '../github/client.js';
import { reviewEvent } from '../github/events.js';
import { runGitHubReview } from '../github/run.js';
import { formatGitHubReview } from '../render/github.js';

export async function runAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!env.GITHUB_EVENT_PATH) throw new Error('GitHub event file is unavailable');
  const bytes = readFileSync(env.GITHUB_EVENT_PATH);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('GitHub event exceeds size limit');
  const event = reviewEvent(env.GITHUB_EVENT_NAME ?? '', JSON.parse(bytes.toString('utf8')));
  if (!event) return 0;
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub token is unavailable');
  const summary = (text: string): void => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  const client = new GitHubClient(token);
  if (!event.automatic && !(await client.canReview(event.repository, event.sender))) {
    summary('Review request ignored: the requester must have write access to this repository.');
    return 0;
  }
  if (!env.MODEL_GATEWAY_API_KEY || !env.MODEL_GATEWAY_BASE_URL || !env.REVIEW_AGENT_MODEL) {
    summary(
      'Review did not run: configure the model key, API base URL and model. Fork workflows do not receive repository secrets; use the maintainer-triggered workflow described in the setup guide.',
    );
    return 1;
  }
  const result = await runGitHubReview({
    ...event,
    token,
    actor: 'github-actions[bot]',
    publish: env.REVIEW_PUBLISH !== 'false',
    ...(event.head ? { expectedHead: event.head } : {}),
  });
  summary(result.review ? formatGitHubReview(result.review) : `Review outcome: ${result.outcome}.`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `outcome=${result.outcome}\nblocked=${result.blocked ?? false}\n`,
    );
  return result.outcome === 'failed' ||
    result.outcome === 'changed' ||
    (result.failOnFindings && result.blocked)
    ? 1
    : 0;
}

if (isMainModule(import.meta.url))
  runAction()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        'Review could not complete. Check repository permissions, configuration and service availability.\n',
      );
      process.exitCode = 1;
    });
