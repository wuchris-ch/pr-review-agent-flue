import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { indexDiff } from '../core/diff/parse.js';
import type { EvidencePacket, SourceAnchor } from '../core/diff/types.js';
import { excluded, type RepositoryConfig } from '../core/repository-config.js';

export interface RepositoryReader {
  /** Reads must refer to this frozen source revision, never a moving branch. */
  revision: string;
  paths(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
}

export interface RepositoryContext {
  revision: string;
  files: Array<{ path: string; content: string; sha256: string }>;
  scanned: number;
  limited: boolean;
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

/** Add exact, read-only line anchors. Existing diff targets remain the only blame locations. */
export function enrichPacket(
  packet: EvidencePacket,
  context: RepositoryContext,
  budget: number,
): EvidencePacket {
  const anchors = new Map(packet.anchors);
  const wanted = identifiers(packet.text);
  const sections: string[] = [];
  let used = 0;
  for (const [index, file] of context.files.entries()) {
    const lines = file.content.split('\n');
    const selected = new Set<number>();
    for (const [line, text] of lines.entries()) {
      if ([...identifiers(text)].some((word) => wanted.has(word))) {
        for (let n = Math.max(0, line - 3); n <= Math.min(lines.length - 1, line + 5); n++)
          selected.add(n);
      }
    }
    const header = `Repository context ${JSON.stringify(file.path)} at ${context.revision} (read-only):\n`;
    const source: SourceAnchor[] = [];
    const rendered: string[] = [];
    for (const line of [...selected].sort((a, b) => a - b).slice(0, 100)) {
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
  const run = (args: string[], maxBuffer: number): Buffer | undefined => {
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
    return result.status === 0 && !result.error ? result.stdout : undefined;
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
    async read(path) {
      if (!safeSourcePath(path)) return undefined;
      const content = run(['show', `${revision}:${path}`], 32 * 1024 + 1);
      if (!content) return undefined;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        return undefined;
      }
    },
  };
}
