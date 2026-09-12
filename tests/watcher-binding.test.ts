import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDiff } from '../src/input.js';
import { GitHubClient, type PullRequest, type PullRequestReview, type ReviewBinding } from '../src/github.js';
import { formatAutomatedReview, reviewPullRequest } from '../src/watcher.js';
import type { Review } from '../src/schema.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40), next = 'c'.repeat(40), mergeBase = 'd'.repeat(40);
const diff = decodeDiff(Buffer.from('diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n'));
const clean: Review = { schema_version: '1.0', input_sha256: diff.sha256, risk: 'low', blocked: false, findings: [], rationale: 'No findings.' };
const blocked: Review = { ...clean, risk: 'medium', blocked: true, findings: [{ severity: 'major', category: 'correctness', file: 'a.py', line: 1, detail: 'A demonstrated regression.' }] };
const binding: ReviewBinding = { base, head, merge_base: mergeBase, diff: diff.sha256 };
const initial: PullRequest = { number: 1, html_url: 'https://github.com/owner/repo/pull/1', state: 'open', head: { sha: head }, base: { sha: base } };

function fixture() {
  let current = structuredClone(initial);
  const reviews: PullRequestReview[] = [];
  const statuses = new Map<string, { context: string; state: string; target_url: string }>();
  const client = {
    getPullRequest: vi.fn(async () => structuredClone(current)),
    snapshotDiff: vi.fn(async (_repo: string, snapshot: PullRequest) => ({ diff, binding: { ...binding, base: snapshot.base.sha, head: snapshot.head.sha } })),
    listReviews: vi.fn(async () => [...reviews]),
    publishReview: vi.fn(async (_repo: string, _number: number, commit: string, body: string) => {
      const review: PullRequestReview = { id: reviews.length + 1, commit_id: commit, state: 'COMMENTED', body, user: { login: 'reviewer' } };
      reviews.push(review); return review;
    }),
    latestStatus: vi.fn(async (_repo: string, commit: string) => statuses.get(commit)),
    setStatus: vi.fn(async (_repo: string, commit: string, state: string, _description: string, url: string) => { statuses.set(commit, { context: 'PR review agent', state, target_url: url }); }),
  };
  const reviewer = vi.fn(() => clean);
  const run = () => reviewPullRequest(client, 'owner/repo', { number: 1 }, 'reviewer', reviewer);
  return { client, reviewer, run, reviews, statuses, push: () => { current.head.sha = next; }, moveBase: () => { current.base.sha = next; }, close: () => { current.state = 'closed'; } };
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('revision-bound watcher publication', () => {
  it('uses the fresh PR head, not the head from the earlier polling list', async () => {
    const f = fixture(); f.push();
    expect(await f.run()).toBe('reviewed');
    expect(f.client.snapshotDiff.mock.calls[0]?.[1].head.sha).toBe(next);
    expect(f.reviews[0]?.commit_id).toBe(next);
    expect([...f.statuses.keys()]).toEqual([next]);
  });

  it('abandons an immutable old diff when a push arrives during its fetch', async () => {
    const f = fixture();
    f.client.snapshotDiff.mockImplementationOnce(async () => { f.push(); return { diff, binding }; });
    expect(await f.run()).toBe('changed');
    expect(f.reviewer).not.toHaveBeenCalled();
    expect(f.client.publishReview).not.toHaveBeenCalled();
    expect(f.statuses.size).toBe(0);
  });

  it.each(['head', 'base'] as const)('discards findings when the %s changes during analysis', async (field) => {
    const f = fixture();
    f.reviewer.mockImplementation(() => { field === 'head' ? f.push() : f.moveBase(); return clean; });
    expect(await f.run()).toBe('changed');
    expect(f.client.publishReview).not.toHaveBeenCalled();
    expect(f.statuses.get(head)?.state).toBe('error');
    expect(f.statuses.has(next)).toBe(false);
  });

  it('posts an explicit commit_id and never assigns a publication-race result to the new head', async () => {
    const f = fixture();
    const publish = f.client.publishReview.getMockImplementation()!;
    f.client.publishReview.mockImplementation(async (...args) => { f.push(); return publish(...args); });
    expect(await f.run()).toBe('changed');
    expect(f.reviews[0]?.commit_id).toBe(head);
    expect(f.statuses.get(head)?.state).toBe('error');
    expect(f.statuses.has(next)).toBe(false);
  });

  it('reconciles a POST that committed on GitHub but whose response was lost', async () => {
    const f = fixture();
    const publish = f.client.publishReview.getMockImplementation()!;
    f.client.publishReview.mockImplementation(async (...args) => { await publish(...args); throw new Error('lost response with private text'); });
    expect(await f.run()).toBe('reviewed');
    expect(f.reviews).toHaveLength(1);
    expect(f.statuses.get(head)?.state).toBe('success');
    expect(await f.run()).toBe('reconciled');
    expect(f.client.publishReview).toHaveBeenCalledTimes(1);
    expect(f.reviewer).toHaveBeenCalledTimes(1);
  });

  it('recovers after a restart between review creation and final status without another model call', async () => {
    const f = fixture();
    f.reviews.push({ id: 12, state: 'COMMENTED', commit_id: head, user: { login: 'reviewer' }, body: formatAutomatedReview(blocked, head, binding) });
    expect(await f.run()).toBe('reconciled');
    expect(f.statuses.get(head)).toMatchObject({ state: 'failure', target_url: expect.stringContaining('#pullrequestreview-12') });
    expect(f.reviewer).not.toHaveBeenCalled();
    expect(f.client.snapshotDiff).not.toHaveBeenCalled();
    expect(f.client.publishReview).not.toHaveBeenCalled();
    const writes = f.client.setStatus.mock.calls.length;
    expect(await f.run()).toBe('reconciled');
    expect(f.client.setStatus).toHaveBeenCalledTimes(writes);
  });

  it('does not silently treat another author, commit, or base binding as a receipt', async () => {
    const f = fixture();
    const body = formatAutomatedReview(clean, head, binding);
    f.reviews.push({ id: 1, state: 'COMMENTED', commit_id: head, user: { login: 'someone-else' }, body });
    f.reviews.push({ id: 2, state: 'COMMENTED', commit_id: next, user: { login: 'reviewer' }, body });
    f.reviews.push({ id: 3, state: 'COMMENTED', commit_id: head, user: { login: 'reviewer' }, body: formatAutomatedReview(clean, head, { ...binding, base: next }) });
    expect(await f.run()).toBe('reviewed');
    expect(f.reviewer).toHaveBeenCalledTimes(1);
    expect(f.client.publishReview).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost final-status response without creating another review', async () => {
    const f = fixture();
    const setStatus = f.client.setStatus.getMockImplementation()!;
    let loseResponse = true;
    f.client.setStatus.mockImplementation(async (...args) => {
      await setStatus(...args);
      if (args[2] === 'success' && loseResponse) { loseResponse = false; throw new Error('lost response'); }
    });
    expect(await f.run()).toBe('failed');
    expect(await f.run()).toBe('reconciled');
    expect(f.statuses.get(head)?.state).toBe('success');
    expect(f.client.publishReview).toHaveBeenCalledTimes(1);
    expect(f.reviewer).toHaveBeenCalledTimes(1);
  });

  it('invalidates the old-head status when a base move is observed during final publication', async () => {
    const f = fixture();
    const latestStatus = f.client.latestStatus.getMockImplementation()!;
    f.client.latestStatus.mockImplementation(async (...args) => { f.moveBase(); return latestStatus(...args); });
    expect(await f.run()).toBe('changed');
    expect(f.statuses.get(head)?.state).toBe('error');
    expect(f.statuses.has(next)).toBe(false);
  });

  it('gives an old head-only marker one fully bound review, then deduplicates it', async () => {
    const f = fixture();
    f.reviews.push({ id: 1, state: 'COMMENTED', commit_id: head, user: { login: 'reviewer' }, body: formatAutomatedReview(clean, head) });
    expect(await f.run()).toBe('reviewed');
    expect(await f.run()).toBe('reconciled');
    expect(f.reviews).toHaveLength(2);
    expect(f.client.publishReview).toHaveBeenCalledTimes(1);
  });

  it('rechecks an unchanged head when its base changes', async () => {
    const f = fixture();
    expect(await f.run()).toBe('reviewed');
    f.moveBase();
    expect(await f.run()).toBe('reviewed');
    expect(f.reviews).toHaveLength(2);
    expect(f.reviews[0]?.body).toContain(`"base":"${base}"`);
    expect(f.reviews[1]?.body).toContain(`"base":"${next}"`);
  });

  it('does not publish a verdict with a different input digest', async () => {
    const f = fixture(); f.reviewer.mockReturnValue({ ...clean, input_sha256: 'f'.repeat(64) });
    expect(await f.run()).toBe('failed');
    expect(f.client.publishReview).not.toHaveBeenCalled();
    expect(f.statuses.get(head)?.state).toBe('error');
  });

  it('leaves an unconfirmed publication as an error, then reconciles its eventual receipt', async () => {
    const f = fixture();
    let pending: PullRequestReview | undefined;
    f.client.publishReview.mockImplementation(async (_repo, _number, commit, body) => {
      pending = { id: 1, state: 'COMMENTED', commit_id: commit, body, user: { login: 'reviewer' } };
      throw new Error('lost response');
    });
    expect(await f.run()).toBe('failed');
    expect(f.statuses.get(head)?.state).toBe('error');
    f.reviews.push(pending!);
    expect(await f.run()).toBe('reconciled');
    expect(f.client.publishReview).toHaveBeenCalledTimes(1);
    expect(f.reviewer).toHaveBeenCalledTimes(1);
  });

  it('skips a PR closed since the polling list was fetched', async () => {
    const f = fixture(); f.close();
    expect(await f.run()).toBe('closed');
    expect(f.reviewer).not.toHaveBeenCalled();
    expect(f.client.setStatus).not.toHaveBeenCalled();
  });
});

describe('GitHub immutable diff transport', () => {
  it('resolves the merge base and fetches the diff using only full immutable commit IDs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, files: [{ filename: 'a.py' }] }))
      .mockResolvedValueOnce(new Response(diff.bytes));
    const client = new GitHubClient('test-only', fetcher);
    expect(await client.snapshotDiff('owner/repo', initial)).toEqual({ binding, diff });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/owner/repo/compare/${base}...${head}?per_page=1`);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://api.github.com/repos/owner/repo/compare/${mergeBase}...${head}`);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ accept: 'application/vnd.github.v3.diff' });
  });

  it('sends commit_id in the actual GitHub API POST body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1 }));
    await new GitHubClient('test-only', fetcher).publishReview('owner/repo', 1, head, 'review body');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ event: 'COMMENT', commit_id: head, body: 'review body' });
  });

  it('reads beyond the first review page before deciding whether a receipt exists', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_, id) => ({ id }))))
      .mockResolvedValueOnce(Response.json([{ id: 101 }]));
    const reviews = await new GitHubClient('test-only', fetcher).listReviews('owner/repo', 1);
    expect(reviews).toHaveLength(101);
    expect(fetcher.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('rejects comparison identity mismatches, capped file lists, and oversized diff streams', async () => {
    for (const payload of [
      { base_commit: { sha: next }, merge_base_commit: { sha: mergeBase }, files: [] },
      { base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, files: Array(300).fill({}) },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
      await expect(new GitHubClient('test-only', fetcher).snapshotDiff('owner/repo', initial)).rejects.toThrow(/coverage could not be verified/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ base_commit: { sha: base }, merge_base_commit: { sha: mergeBase }, files: [] }))
      .mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(new GitHubClient('test-only', fetcher).snapshotDiff('owner/repo', initial)).rejects.toThrow(/budget/);
  });
});
