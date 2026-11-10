import { boundedFetch, type GatewayConfig } from '../agents/gateway.js';
import { parseStrictJson } from '../core/json.js';

/** One changed file in a pull request, with its unified diff. */
export interface ChangedFile {
  path: string;
  patch: string;
}

/** One documentation page and its current text. */
export interface DocPage {
  path: string;
  content: string;
}

/** A page the change probably made stale, with the changed code behind it. */
export interface StaleDocFlag {
  page: string;
  reason: string;
  changedCode: string[];
}

export interface StaleDocsResult {
  /** Changed files that are not documentation. Empty means the model was not asked. */
  codeFiles: string[];
  flags: StaleDocFlag[];
}

/** Sends one system and one user message and returns the reply text. */
export type ChatModel = (system: string, user: string) => Promise<string>;

/** Hidden marker that identifies the check's own pull request comment. */
export const COMMENT_MARKER = '<!-- stale-docs-check -->';

const MAX_PATCH_CHARS = 12_000;
const MAX_CODE_CHARS = 60_000;
const MAX_PAGE_CHARS = 24_000;
const MAX_DOCS_CHARS = 160_000;
const MAX_REASON_CHARS = 600;
const BACKTICK = String.fromCharCode(96);

export const STALE_DOCS_INSTRUCTIONS = [
  'You maintain the documentation of a software repository. A pull request changed some code.',
  'Decide which documentation pages now describe behavior, commands, settings, defaults, limits, file paths or interfaces that the code change made wrong or incomplete.',
  'Flag a page only when a specific statement on that page conflicts with the change or leaves out something a reader now needs.',
  'Do not flag a page for unrelated changes, for refactors that keep the documented behavior, or for style.',
  'Dated result records describe past runs and are never stale.',
  'If the pull request already updates a page to match the change, do not flag that page.',
  'Reply with one JSON object and nothing else:',
  '{"stale_pages": [{"page": "<page path exactly as given>", "reason": "<one or two sentences: the statement on the page and what the change made wrong>", "changed_code": ["<changed code path exactly as given>"]}]}',
  'Use an empty list when no page is stale.',
].join('\n');

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

/** Add sections in order until the budget runs out, then list the rest by path. */
function withinBudget(sections: { path: string; text: string }[], budget: number): string[] {
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of sections) {
    if (used + section.text.length <= budget) {
      included.push(section.text);
      used += section.text.length;
    } else {
      omitted.push(section.path);
    }
  }
  if (omitted.length) {
    included.push(`Omitted for size: ${omitted.join(', ')}`);
  }
  return included;
}

export function staleDocsPrompt(
  code: ChangedFile[],
  changedDocs: string[],
  pages: DocPage[],
): string {
  const codeSections = code.map((file) => ({
    path: file.path,
    text: `<change path="${file.path}">\n${bounded(file.patch, MAX_PATCH_CHARS)}\n</change>`,
  }));
  const pageSections = pages.map((page) => ({
    path: page.path,
    text: `<page path="${page.path}">\n${bounded(page.content, MAX_PAGE_CHARS)}\n</page>`,
  }));
  return [
    '# Changed code',
    ...withinBudget(codeSections, MAX_CODE_CHARS),
    '# Documentation pages this pull request also changed',
    changedDocs.length ? changedDocs.join('\n') : 'None',
    '# Documentation pages',
    ...withinBudget(pageSections, MAX_DOCS_CHARS),
  ].join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep only flags grounded in the inputs.
 *
 * A flag must name a page the model was given and at least one changed code
 * file, so a reply cannot point a reader at a page or a change that does not
 * exist. Several flags for one page merge into one.
 */
export function parseStaleDocs(
  reply: string,
  pages: DocPage[],
  codeFiles: string[],
): StaleDocFlag[] {
  const value = parseStrictJson(reply);
  if (!isRecord(value) || !Array.isArray(value.stale_pages)) {
    throw new Error('model reply does not contain a stale_pages list');
  }
  const codePaths = new Set(codeFiles);
  const byPage = new Map<string, StaleDocFlag>();
  for (const item of value.stale_pages) {
    if (!isRecord(item) || typeof item.page !== 'string' || typeof item.reason !== 'string') {
      continue;
    }
    const reason = item.reason.trim().slice(0, MAX_REASON_CHARS);
    const cited = Array.isArray(item.changed_code) ? item.changed_code : [];
    const changedCode = cited.filter(
      (path): path is string => typeof path === 'string' && codePaths.has(path),
    );
    if (!reason || !changedCode.length) {
      continue;
    }
    const existing = byPage.get(item.page);
    if (existing) {
      existing.reason = `${existing.reason} ${reason}`;
      existing.changedCode = [...new Set([...existing.changedCode, ...changedCode])];
    } else {
      byPage.set(item.page, { page: item.page, reason, changedCode });
    }
  }
  // Report pages in the order they were given, and only pages that exist.
  return pages.flatMap((page) => byPage.get(page.path) ?? []);
}

export async function findStaleDocs(
  changes: ChangedFile[],
  pages: DocPage[],
  model: ChatModel,
): Promise<StaleDocsResult> {
  const pagePaths = new Set(pages.map((page) => page.path));
  const isDocumentation = (path: string): boolean =>
    pagePaths.has(path) || path.toLowerCase().endsWith('.md');
  const code = changes.filter((change) => !isDocumentation(change.path));
  const codeFiles = code.map((change) => change.path);
  if (!code.length) {
    return { codeFiles, flags: [] };
  }
  const changedDocs = changes
    .filter((change) => isDocumentation(change.path))
    .map((change) => change.path);
  const reply = await model(STALE_DOCS_INSTRUCTIONS, staleDocsPrompt(code, changedDocs, pages));
  return { codeFiles, flags: parseStaleDocs(reply, pages, codeFiles) };
}

function tableCell(text: string): string {
  return text.replace(/\s+/g, ' ').replaceAll('|', '\\|');
}

function codeSpan(text: string): string {
  return BACKTICK + tableCell(text) + BACKTICK;
}

export function renderStaleDocsReport(result: StaleDocsResult): string {
  const heading = `${COMMENT_MARKER}\n### Stale documentation check`;
  if (!result.codeFiles.length) {
    return `${heading}\n\nThis pull request changes no code, so no documentation was checked.`;
  }
  if (!result.flags.length) {
    return (
      heading +
      '\n\nNo documentation page looks stale after the changes to ' +
      String(result.codeFiles.length) +
      ' code file(s).'
    );
  }
  const rows = result.flags.map(
    (flag) =>
      '| ' +
      [codeSpan(flag.page), tableCell(flag.reason), flag.changedCode.map(codeSpan).join(', ')].join(
        ' | ',
      ) +
      ' |',
  );
  return [
    heading,
    '',
    'This pull request changes code that these pages describe. Check them before merging.',
    '',
    '| Page | Why it may be stale | Changed code |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** A chat model behind the configured OpenAI-compatible model gateway. */
export function gatewayChatModel(
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): ChatModel {
  return async (system, user) => {
    const request = boundedFetch(fetchImpl, { rejected: false }, config.networkBudgetMs);
    const response = await request(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxOutputTokens,
        response_format: { type: 'json_object' },
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: config.reasoningEffort }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`model gateway returned HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('model gateway reply has no message content');
    }
    return content;
  };
}
