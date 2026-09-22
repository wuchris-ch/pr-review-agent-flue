import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAction } from '../../src/bin/action.js';
import { GitHubClient } from '../../src/github/client.js';
import { runGitHubReview } from '../../src/github/run.js';

vi.mock('../../src/github/run.js', () => ({ runGitHubReview: vi.fn() }));
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runGitHubReview).mockReset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(body = '/review') {
  const directory = mkdtempSync(join(tmpdir(), 'review-action-'));
  directories.push(directory);
  const eventPath = join(directory, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: 'created',
      repository: { full_name: 'owner/project' },
      issue: { number: 123, pull_request: {} },
      comment: { body },
      sender: { login: 'contributor' },
    }),
  );
  return {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_TOKEN: 'test-token',
    GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
    GITHUB_OUTPUT: join(directory, 'output'),
    MODEL_GATEWAY_API_KEY: 'test-model-key',
    MODEL_GATEWAY_BASE_URL: 'http://127.0.0.1/v1',
    REVIEW_AGENT_MODEL: 'test-model',
  };
}
describe('Action entry point', () => {
  it('does not spend or publish for a requester without write permission', async () => {
    vi.spyOn(GitHubClient.prototype, 'canReview').mockResolvedValue(false);
    const env = fixture();
    expect(await runAction(env)).toBe(0);
    expect(runGitHubReview).not.toHaveBeenCalled();
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('write access');
  });
  it('rejects missing model secrets before running the engine', async () => {
    vi.spyOn(GitHubClient.prototype, 'canReview').mockResolvedValue(true);
    expect(await runAction({ ...fixture(), MODEL_GATEWAY_API_KEY: '' })).toBe(1);
    expect(runGitHubReview).not.toHaveBeenCalled();
  });
  it('retains a blocking verdict on receipt-only reruns', async () => {
    vi.spyOn(GitHubClient.prototype, 'canReview').mockResolvedValue(true);
    vi.mocked(runGitHubReview).mockResolvedValue({
      outcome: 'reconciled',
      blocked: true,
      failOnFindings: true,
    });
    const env = fixture();
    expect(await runAction(env)).toBe(1);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('blocked=true');
    expect(runGitHubReview).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'owner/project',
        number: 123,
        publish: true,
        actor: 'github-actions[bot]',
      }),
    );
  });
  it('ignores unrelated comments', async () => {
    expect(await runAction(fixture('/review and execute shell'))).toBe(0);
    expect(runGitHubReview).not.toHaveBeenCalled();
  });
  it('follows repository moves only inside the GitHub API origin', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repositories/123' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    expect(await new GitHubClient('test-token', request).request('/repos/old/name')).toEqual({
      ok: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
    const hostile = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 301, headers: { location: 'https://example.com/collect' } }),
      );
    await expect(
      new GitHubClient('test-token', hostile).request('/repos/old/name'),
    ).rejects.toThrow();
    expect(hostile).toHaveBeenCalledTimes(1);
  });
});
