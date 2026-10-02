import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { indexDiff } from '../core/diff/parse.js';
import type { EvidencePacket, SourceAnchor } from '../core/diff/types.js';
import { excluded, type RepositoryConfig } from '../core/repository-config.js';

export interface RepositoryReader {
  /** Reads must refer to this frozen source revision, never a moving branch. */
  revision: string;
  paths(): Promise<string[]>;
  /** Files larger than `maxBytes` (default 32 KiB) read as undefined. */
  read(path: string, maxBytes?: number): Promise<string | undefined>;
  /**
   * Fixed-string search across the revision. Optional: readers backed by a
   * hosting API cannot search a frozen revision, so exploration then reads only.
   */
  search?(text: string, pathPrefix: string | undefined, limit: number): Promise<SearchMatch[]>;
}

export interface SearchMatch {
  path: string;
  /** One-based line number. */
  line: number;
  text: string;
}

export interface RepositoryContext {
  revision: string;
  files: ContextFile[];
  scanned: number;
  limited: boolean;
}

export interface ContextFile {
  path: string;
  content: string;
  sha256: string;
  /**
   * Zero-based lines an exploration lookup asked to see. When present, the
   * packet shows windows around these lines instead of identifier matches.
   */
  focus?: number[];
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|sql|md|json|ya?ml|toml)$/i;
const SENSITIVE =
  /(?:^|\/)(?:\.env(?:\..*)?|\.git|node_modules|vendor|dist|build|coverage|.*\.(?:pem|key|p12|lock))$/i;
const STOP = new Set(
  'const let return function class export import from if else try catch throw async await true false null none self this string number value data error'.split(
    ' ',
  ),
);
export function identifiers(text: string): Set<string> {
  return new Set(
    (text.match(/[A-Za-z_][A-Za-z_0-9]{3,}/g) ?? []).filter(
      (word) => !STOP.has(word.toLowerCase()),
    ),
  );
}

export function safeSourcePath(path: string): boolean {
  return (
    path.length <= 512 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    path.split('/').every((segment) => segment !== '..' && segment !== '.' && segment !== '') &&
    !path.split('/').some((segment) => SENSITIVE.test(segment))
  );
}

/** Bounded lexical retrieval. Source content is data; no repository code is executed. */
export async function retrieveContext(
  diff: string,
  reader: RepositoryReader,
  config: RepositoryConfig,
): Promise<RepositoryContext> {
  const changed = new Set(indexDiff(diff).map((file) => file.path));
  const wanted = identifiers(diff);
  const names = new Set(
    [...changed].flatMap((path) => [...identifiers(path.replaceAll('/', ' '))]),
  );
  const paths = (await reader.paths()).filter(
    (path) => safeSourcePath(path) && SOURCE.test(path) && !excluded(path, config),
  );
  const priority = (path: string): number =>
    (changed.has(path) ? 100 : 0) +
    [...names].filter((name) => path.includes(name)).length * 10 +
    (/test|spec|contract|README/i.test(path) ? 5 : 0);
  paths.sort((a, b) => priority(b) - priority(a) || a.localeCompare(b));
  const candidates: Array<{ path: string; content: string; sha256: string; score: number }> = [];
  let scanned = 0;
  let bytes = 0;
  for (const path of paths.slice(0, 40)) {
    const content = await reader.read(path);
    scanned++;
    if (!content || content.includes('\0') || Buffer.byteLength(content) > 32 * 1024) continue;
    bytes += Buffer.byteLength(content);
    if (bytes > 256 * 1024) break;
    const score =
      [...identifiers(content)].filter((word) => wanted.has(word)).length + priority(path);
    if (score < 2) continue;
    candidates.push({
      path,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    revision: reader.revision,
    files: candidates.slice(0, 12).map(({ score: _score, ...file }) => file),
    scanned,
    limited: scanned < paths.length,
  };
}

/** Lines shown around each explored focus line. */
const FOCUS_BEFORE = 6;
const FOCUS_AFTER = 30;

/**
 * Line numbers to show: every line of a whole file, windows around lines an
 * exploration lookup asked for, or windows around shared identifiers.
 */
function selectLines(
  lines: readonly string[],
  wanted: Set<string>,
  whole: boolean,
  focus?: readonly number[],
): number[] {
  if (whole) return [...lines.keys()];
  const selected = new Set<number>();
  if (focus?.length) {
    for (const center of focus) {
      const last = Math.min(lines.length - 1, center + FOCUS_AFTER);
      for (let n = Math.max(0, center - FOCUS_BEFORE); n <= last; n++) selected.add(n);
    }
    return [...selected].sort((a, b) => a - b).slice(0, 160);
  }
  for (const [line, text] of lines.entries()) {
    if ([...identifiers(text)].some((word) => wanted.has(word))) {
      for (let n = Math.max(0, line - 3); n <= Math.min(lines.length - 1, line + 5); n++)
        selected.add(n);
    }
  }
  return [...selected].sort((a, b) => a - b).slice(0, 100);
}

/** Add exact, read-only line anchors. Existing diff targets remain the only blame locations. */
export function enrichPacket(
  packet: EvidencePacket,
  context: RepositoryContext,
  budget: number,
): EvidencePacket {
  const anchors = new Map(packet.anchors);
  const wanted = identifiers(packet.text);
  // Files changed in this packet come first and, when they fit, appear whole: a defect
  // such as a call that re-enters the same class is only visible with the class in view.
  const changed = new Set(
    [...packet.targets].map((id) => packet.anchors.get(id)?.file).filter(Boolean),
  );
  // Then excerpts the reviewer explicitly looked up, then lexical matches.
  const rank = (file: ContextFile): number =>
    changed.has(file.path) ? 2 : file.focus?.length ? 1 : 0;
  const ordered = [...context.files.entries()].sort(
    ([, left], [, right]) => rank(right) - rank(left),
  );
  const sections: string[] = [];
  let used = 0;
  for (const [index, file] of ordered) {
    const lines = file.content.split('\n');
    const whole =
      changed.has(file.path) && Buffer.byteLength(file.content) + 16 * lines.length < budget - used;
    const header = `Repository context ${JSON.stringify(file.path)} at ${context.revision} (read-only):\n`;
    const source: SourceAnchor[] = [];
    const rendered: string[] = [];
    for (const line of selectLines(lines, wanted, whole, file.focus)) {
      const anchor: SourceAnchor = {
        id: `R${index + 1}N${line + 1}`,
        file: file.path,
        line: line + 1,
        side: 'head',
        text: lines[line] ?? '',
        target: false,
      };
      source.push(anchor);
      rendered.push(`[${anchor.id}] ${anchor.text}`);
    }
    if (!rendered.length) continue;
    const text = header + rendered.join('\n');
    const size = Buffer.byteLength(text) + 2;
    if (used + size > budget) continue;
    used += size;
    sections.push(text);
    for (const anchor of source) anchors.set(anchor.id, anchor);
  }
  return { ...packet, anchors, text: [packet.text, ...sections].join('\n\n') };
}

export function gitReader(root: string, revision: string): RepositoryReader {
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('context requires an immutable Git revision');
  const run = (args: string[], maxBuffer: number, allowNoMatch = false): Buffer | undefined => {
    const result = spawnSync(
      'git',
      ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: root,
        encoding: 'buffer',
        timeout: 15_000,
        maxBuffer,
      },
    );
    // A search that overflows its buffer or time still returns the matches it found.
    if (result.error) return allowNoMatch && result.stdout?.length ? result.stdout : undefined;
    // git grep exits 1 when nothing matches, which is an answer rather than a failure.
    if (result.status === 0 || (allowNoMatch && result.status === 1)) return result.stdout;
    return undefined;
  };
  return {
    revision,
    async paths() {
      const bytes = run(['ls-tree', '-r', '-z', revision], 2 * 1024 * 1024);
      if (!bytes) throw new Error('unable to list repository context');
      return bytes
        .toString('utf8')
        .split('\0')
        .filter((line) => /^100(?:644|755) blob /.test(line))
        .map((line) => line.slice(line.indexOf('\t') + 1));
    },
    async read(path, maxBytes = 32 * 1024) {
      if (!safeSourcePath(path)) return undefined;
      const content = run(['show', `${revision}:${path}`], maxBytes + 1);
      if (!content) return undefined;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return undefined;
      }
    },
    async search(text, pathPrefix, limit) {
      if (!text || text.length > 200 || /[\0\r\n]/.test(text)) return [];
      if (pathPrefix !== undefined && !safeSourcePath(pathPrefix.replace(/\/+$/, ''))) return [];
      const output = run(
        [
          'grep',
          '-n',
          '-I',
          '--fixed-strings',
          '--no-color',
          '--max-count=3',
          '-e',
          text,
          revision,
          '--',
          ...(pathPrefix ? [pathPrefix] : []),
        ],
        4 * 1024 * 1024,
        true,
      );
      return output ? parseGrepOutput(output.toString('utf8'), revision, limit) : [];
    },
  };
}

/** Parse `git grep -n <revision>` rows, formatted `<revision>:<path>:<line>:<text>`. */
export function parseGrepOutput(output: string, revision: string, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const row of output.split('\n')) {
    if (!row.startsWith(`${revision}:`)) continue;
    const parsed = /^(.*?):(\d+):(.*)$/.exec(row.slice(revision.length + 1));
    if (!parsed || !safeSourcePath(parsed[1]!)) continue;
    matches.push({ path: parsed[1]!, line: Number(parsed[2]), text: parsed[3]!.slice(0, 240) });
    if (matches.length >= limit) break;
  }
  return matches;
}
