import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gatewayConfig } from '../../src/agents/gateway.js';
import { runStaleDocs, SKIPPED_MESSAGE } from '../../src/bin/stale-docs.js';
import {
  type ChangedFile,
  type ChatModel,
  COMMENT_MARKER,
  type DocPage,
  findStaleDocs,
  gatewayChatModel,
  renderStaleDocsReport,
} from '../../src/docs/stale-docs.js';

const pages: DocPage[] = [
  { path: 'docs/guides/configuration.md', content: 'The default review timeout is 180 seconds.' },
  { path: 'docs/architecture.md', content: 'Reviews run in an isolated child process.' },
];

const configChange: ChangedFile = {
  path: 'src/agents/gateway.ts',
  patch:
    '-export const DEFAULT_NETWORK_BUDGET_MS = 180_000;\n+export const DEFAULT_NETWORK_BUDGET_MS = 300_000;',
};

/** A fake model that records its prompt and returns a fixed reply. */
function fakeModel(reply: unknown): ChatModel & { prompts: string[] } {
  const prompts: string[] = [];
  const model = async (_system: string, user: string): Promise<string> => {
    prompts.push(user);
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  return Object.assign(model, { prompts });
}

describe('stale documentation check', () => {
  it('flags a page the code change made stale and shows the model the diff and pages', async () => {
    const model = fakeModel({
      stale_pages: [
        {
          page: 'docs/guides/configuration.md',
          reason: 'The page says the default timeout is 180 seconds; the change makes it 300.',
          changed_code: ['src/agents/gateway.ts'],
        },
      ],
    });

    const result = await findStaleDocs([configChange], pages, model);

    expect(result).toEqual({
      codeFiles: ['src/agents/gateway.ts'],
      flags: [
        {
          page: 'docs/guides/configuration.md',
          reason: 'The page says the default timeout is 180 seconds; the change makes it 300.',
          changedCode: ['src/agents/gateway.ts'],
        },
      ],
    });
    expect(model.prompts[0]).toContain('+export const DEFAULT_NETWORK_BUDGET_MS = 300_000;');
    expect(model.prompts[0]).toContain('<page path="docs/guides/configuration.md">');
    expect(model.prompts[0]).toContain('The default review timeout is 180 seconds.');
  });

  it('drops flags for unknown pages, unchanged code or empty reasons, and merges one page', async () => {
    const model = fakeModel({
      stale_pages: [
        {
          page: 'docs/missing.md',
          reason: 'Invented page.',
          changed_code: ['src/agents/gateway.ts'],
        },
        {
          page: 'docs/architecture.md',
          reason: 'Cites unchanged code.',
          changed_code: ['src/cli.ts'],
        },
        { page: 'docs/architecture.md', reason: '  ', changed_code: ['src/agents/gateway.ts'] },
        {
          page: 'docs/guides/configuration.md',
          reason: 'Timeout changed.',
          changed_code: ['src/agents/gateway.ts'],
        },
        {
          page: 'docs/guides/configuration.md',
          reason: 'Retry budget changed.',
          changed_code: ['src/agents/runtime.ts', 'src/agents/gateway.ts'],
        },
      ],
    });
    const runtimeChange = { path: 'src/agents/runtime.ts', patch: '+retry' };

    const { flags } = await findStaleDocs([configChange, runtimeChange], pages, model);

    expect(flags).toEqual([
      {
        page: 'docs/guides/configuration.md',
        reason: 'Timeout changed. Retry budget changed.',
        changedCode: ['src/agents/gateway.ts', 'src/agents/runtime.ts'],
      },
    ]);
  });

  it('does not ask the model when only documentation changed', async () => {
    const model = vi.fn<ChatModel>();
    const docsChange = { path: 'docs/architecture.md', patch: '+More detail.' };

    const result = await findStaleDocs(
      [docsChange, { path: 'notes/plan.md', patch: '+x' }],
      pages,
      model,
    );

    expect(model).not.toHaveBeenCalled();
    expect(result).toEqual({ codeFiles: [], flags: [] });
    expect(renderStaleDocsReport(result)).toContain('changes no code');
  });

  it('tells the model which pages the pull request already updated', async () => {
    const model = fakeModel({ stale_pages: [] });
    const docsChange = { path: 'docs/guides/configuration.md', patch: '+300 seconds' };

    const result = await findStaleDocs([configChange, docsChange], pages, model);

    expect(result.flags).toEqual([]);
    expect(model.prompts[0]).toMatch(
      /# Documentation pages this pull request also changed\n\ndocs\/guides\/configuration\.md/,
    );
    expect(model.prompts[0]).not.toContain('<change path="docs/guides/configuration.md">');
  });

  it('rejects a reply that is not the expected JSON object', async () => {
    await expect(
      findStaleDocs([configChange], pages, fakeModel('Looks fine to me.')),
    ).rejects.toThrow();
    await expect(findStaleDocs([configChange], pages, fakeModel({ pages: [] }))).rejects.toThrow(
      /stale_pages/,
    );
  });

  it('renders flags as a table that survives pipes and line breaks', () => {
    const report = renderStaleDocsReport({
      codeFiles: ['src/a.ts'],
      flags: [{ page: 'docs/a.md', reason: 'Uses a | b\nnow.', changedCode: ['src/a.ts'] }],
    });

    expect(report.startsWith(COMMENT_MARKER)).toBe(true);
    expect(report).toContain('| Page | Why it may be stale | Changed code |');
    expect(report).toContain('Uses a \\| b now.');
    expect(renderStaleDocsReport({ codeFiles: ['src/a.ts'], flags: [] })).toContain(
      'No documentation page looks stale',
    );
  });

  it('sends one JSON-mode chat completion to the configured gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"stale_pages":[]}' } }] })),
    );
    const config = gatewayConfig({
      MODEL_GATEWAY_API_KEY: 'test-only-key',
      MODEL_GATEWAY_BASE_URL: 'http://127.0.0.1:8790/v1',
      REVIEW_AGENT_MODEL: 'test-model',
    });

    const reply = await gatewayChatModel(config, fetchImpl)('system text', 'user text');

    expect(reply).toBe('{"stale_pages":[]}');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8790/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' },
      ],
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-key');
  });

  it('skips cleanly when no model endpoint is configured', async () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'stale-docs-')), 'summary.md');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const code = await runStaleDocs(['--base', 'origin/main', 'README.md'], {
      GITHUB_STEP_SUMMARY: summary,
    });

    stdout.mockRestore();
    expect(code).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain(SKIPPED_MESSAGE);
  });
});
