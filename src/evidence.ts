import * as v from 'valibot';
import { parseStrictJson } from './json.js';
import { CategorySchema, SeveritySchema, validateReview, type Review } from './schema.js';

export interface SourceAnchor {
  id: string;
  file: string;
  line: number;
  side: 'base' | 'head';
  text: string;
  target: boolean;
}

export interface EvidenceHunk {
  text: string;
  anchors: SourceAnchor[];
}

export interface EvidenceFile {
  path: string;
  text: string;
  hunks: EvidenceHunk[];
}

export interface EvidencePacket {
  text: string;
  anchors: ReadonlyMap<string, SourceAnchor>;
  targets: ReadonlySet<string>;
  retrievedHunks: number;
}

export const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_CONTEXT_HUNKS = 4;
export const MAX_PARTITIONS = 24;

/** Decode Git's quoted UTF-8 paths, including its octal byte escapes. */
function pathFromHeader(raw: string): string | undefined {
  let path = raw.split('\t', 1)[0] ?? '';
  if (path.startsWith('"')) {
    if (!path.endsWith('"')) throw new Error('diff has an invalid quoted path');
    const bytes: number[] = [];
    const body = path.slice(1, -1);
    for (let i = 0; i < body.length;) {
      const escape = /^\\([0-7]{3}|[\\"abfnrtv])/.exec(body.slice(i));
      if (escape) {
        const value = escape[1]!;
        const named: Record<string, number> = { '\\': 92, '"': 34, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
        bytes.push(value.length === 3 ? Number.parseInt(value, 8) : named[value]!);
        i += escape[0].length;
      } else {
        if (body[i] === '\\') throw new Error('diff has an invalid quoted path');
        const character = String.fromCodePoint(body.codePointAt(i)!);
        bytes.push(...Buffer.from(character));
        i += character.length;
      }
    }
    path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  }
  if (path === '/dev/null') return undefined;
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  if (!path || path !== path.trim() || /[\x00-\x1f\x7f\\]/.test(path)
    || path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
    || path.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('diff path must be repository-relative and unambiguous');
  }
  return path;
}

/** Index exact hunk coordinates before any model call. Header suffixes are not source lines. */
export function indexDiff(text: string): EvidenceFile[] {
  const sections = text.split(/(?=^diff --git )/m).filter((part) => part.trim());
  const files: EvidenceFile[] = [];
  const paths = new Set<string>();
  for (const [fileIndex, section] of sections.entries()) {
    const lines = section.split(/\r?\n/);
    const headerEnd = lines.findIndex((line) => line.startsWith('@@'));
    const headers = headerEnd < 0 ? lines : lines.slice(0, headerEnd);
    if (headers.some((line) => line === 'GIT binary patch' || line.startsWith('Binary files '))) {
      throw new Error('binary changes require a separate review; no text verdict was produced');
    }
    const oldHeader = headers.find((line) => line.startsWith('--- '));
    const newHeader = headers.find((line) => line.startsWith('+++ '));
    const gitHeader = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(headers[0] ?? '');
    const gitOld = gitHeader ? pathFromHeader(gitHeader[1]!) : undefined;
    const gitNew = gitHeader ? pathFromHeader(gitHeader[2]!) : undefined;
    const oldPath = oldHeader ? pathFromHeader(oldHeader.slice(4)) : gitOld;
    const newPath = newHeader ? pathFromHeader(newHeader.slice(4)) : gitNew;
    if ((oldPath && gitOld && oldPath !== gitOld) || (newPath && gitNew && newPath !== gitNew)) {
      throw new Error('diff file headers disagree');
    }
    const path = newPath ?? oldPath;
    if (!path || paths.has(path)) throw new Error('diff contains missing or duplicate file paths');
    paths.add(path);
    const hunks: EvidenceHunk[] = [];
    const seen = new Set<string>();
    let previousOldEnd = 0;
    let previousNewEnd = 0;
    let i = headerEnd < 0 ? lines.length : headerEnd;
    while (i < lines.length) {
      if (i === lines.length - 1 && lines[i] === '') break;
      const header = lines[i++]!;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(header);
      if (!match) throw new Error('diff has an invalid or unsupported hunk header');
      let oldLine = Number(match[1]);
      let newLine = Number(match[3]);
      let oldRemaining = Number(match[2] ?? 1);
      let newRemaining = Number(match[4] ?? 1);
      if (![oldLine, newLine, oldRemaining, newRemaining, oldLine + oldRemaining, newLine + newRemaining].every(Number.isSafeInteger)
        || (oldRemaining > 0 && oldLine < 1) || (newRemaining > 0 && newLine < 1)) {
        throw new Error('diff has invalid hunk coordinates');
      }
      if (oldLine < previousOldEnd || newLine < previousNewEnd) throw new Error('diff hunks overlap or are out of order');
      previousOldEnd = oldLine + oldRemaining;
      previousNewEnd = newLine + newRemaining;
      const anchors: SourceAnchor[] = [];
      const rendered = [header];
      let additions = 0;
      while (oldRemaining > 0 || newRemaining > 0) {
        const source = lines[i++];
        if (source === '\\ No newline at end of file') continue;
        if (source === undefined || ![' ', '+', '-'].includes(source[0] ?? '')) {
          throw new Error('diff hunk is truncated or its counts do not match');
        }
        const kind = source[0]!;
        const side = kind === '-' ? 'base' : 'head';
        const line = side === 'base' ? oldLine : newLine;
        const id = `F${fileIndex + 1}${side === 'head' ? 'N' : 'O'}${line}`;
        if (seen.has(id)) throw new Error('diff hunks overlap and cannot be mapped unambiguously');
        seen.add(id);
        const anchor: SourceAnchor = { id, file: side === 'base' ? oldPath ?? path : path, line, side, text: source.slice(1), target: kind === '+' };
        anchors.push(anchor);
        rendered.push(`${kind} [${id}] ${anchor.text}`);
        if (kind !== '+') { oldLine++; oldRemaining--; }
        if (kind !== '-') { newLine++; newRemaining--; }
        if (kind === '+') additions++;
        if (oldRemaining < 0 || newRemaining < 0) throw new Error('diff hunk counts do not match');
      }
      if (lines[i] === '\\ No newline at end of file') i++;
      // A pure deletion has no added line. Keep its original side explicit instead of inventing a head location.
      if (additions === 0) for (const anchor of anchors) anchor.target = anchor.side === 'base';
      hunks.push({ text: rendered.join('\n'), anchors });
    }
    if (hunks.length === 0 && headers.some((line) => /^[+\- ]/.test(line) && !line.startsWith('--- ') && !line.startsWith('+++ '))) {
      throw new Error('changed source is missing a unified diff hunk header');
    }
    files.push({ path, hunks, text: [`File: ${JSON.stringify(path)}`, ...headers, ...hunks.map((hunk) => hunk.text)].join('\n') });
  }
  if (!files.length) throw new Error('diff contains no reviewable files');
  return files;
}

const COMMON_WORDS = new Set('const let var return def function class export import from if else elif try except catch throw raise new true false null none self this async await int str string number bool boolean public private void for while with and or not in is as to of on id data value name result error'.split(' '));
function symbols(text: string): Set<string> {
  return new Set((text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []).filter((word) => !COMMON_WORDS.has(word.toLowerCase())));
}

/** Retrieve related hunks only from the caller-supplied diff, never from the host filesystem. */
export function evidencePackets(files: EvidenceFile[], maxBytes: number): EvidencePacket[] {
  const targetBudget = maxBytes - MAX_CONTEXT_BYTES - 256;
  if (targetBudget <= 0) throw new Error('review guidance leaves no room for source evidence');
  const groups: EvidenceFile[][] = [];
  let group: EvidenceFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.text) + 2;
    if (size > targetBudget) throw new Error('a single diff file exceeds the agent message limit; split the change into a smaller patch');
    if (bytes + size > targetBudget) { groups.push(group); group = []; bytes = 0; }
    group.push(file); bytes += size;
  }
  if (group.length) groups.push(group);
  if (groups.length > MAX_PARTITIONS) throw new Error('diff exceeds the review partition budget');
  return groups.map((targets) => {
    const anchors = new Map<string, SourceAnchor>();
    const targetIds = new Set<string>();
    for (const file of targets) for (const hunk of file.hunks) for (const anchor of hunk.anchors) {
      anchors.set(anchor.id, anchor);
      if (anchor.target) targetIds.add(anchor.id);
    }
    const targetSymbols = symbols(targets.map((file) => file.text).join('\n'));
    const candidates = files.filter((file) => !targets.includes(file)).flatMap((file) => file.hunks.map((hunk) => ({
      hunk, file, score: [...symbols(hunk.text)].filter((word) => targetSymbols.has(word)).length,
    }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const context: string[] = [];
    let contextBytes = 0;
    for (const { file, hunk } of candidates) {
      const rendered = `Related context only, file ${JSON.stringify(file.path)}:\n${hunk.text}`;
      const size = Buffer.byteLength(rendered) + 2;
      if (context.length >= MAX_CONTEXT_HUNKS) break;
      if (contextBytes + size > MAX_CONTEXT_BYTES) continue;
      context.push(rendered); contextBytes += size;
      for (const anchor of hunk.anchors) anchors.set(anchor.id, anchor);
    }
    const text = [
      'Target files (findings must anchor to a + line, or a removed line in a deletion-only hunk):',
      ...targets.map((file) => file.text),
      ...(context.length ? ['Related hunks are read-only evidence. Report their own defects in their target partition.', ...context] : []),
    ].join('\n\n');
    if (Buffer.byteLength(text) > maxBytes) throw new Error('source evidence exceeds the message budget');
    return { text, anchors, targets: targetIds, retrievedHunks: context.length };
  });
}

const EvidenceReferenceSchema = v.strictObject({
  anchor: v.string(),
  quote: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});
const ProposalSchema = v.strictObject({
  schema_version: v.literal('1.0'),
  input_sha256: v.string(),
  risk: v.picklist(['low', 'medium', 'high']),
  blocked: v.boolean(),
  findings: v.pipe(v.array(v.strictObject({
    severity: SeveritySchema,
    category: CategorySchema,
    evidence: EvidenceReferenceSchema,
    related: v.optional(v.pipe(v.array(EvidenceReferenceSchema), v.maxLength(3)), []),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  })), v.maxLength(32)),
  rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});

export class EvidenceValidationError extends Error {}
export class DigestValidationError extends Error {}

export function groundReview(text: string, packet: EvidencePacket, digest: string): Review {
  const parsed = v.safeParse(ProposalSchema, parseStrictJson(text));
  if (!parsed.success) throw new EvidenceValidationError('model output does not match the evidence contract');
  const proposal = parsed.output;
  if (proposal.input_sha256 !== digest) throw new DigestValidationError('model output input_sha256 does not match the reviewed diff');
  const resolve = (ref: v.InferOutput<typeof EvidenceReferenceSchema>, primary: boolean): SourceAnchor => {
    const anchor = packet.anchors.get(ref.anchor);
    const quote = ref.quote.trim();
    if (!anchor || (primary && !packet.targets.has(ref.anchor)) || !quote
      || quote.includes('\n') || !anchor.text.includes(quote)
      || (quote.length < 3 && quote !== anchor.text.trim())) {
      throw new EvidenceValidationError('finding evidence must quote an exact supplied source anchor');
    }
    return anchor;
  };
  const findings = proposal.findings.map((finding) => {
    const source = resolve(finding.evidence, true);
    const related = finding.related.map((ref) => {
      const anchor = resolve(ref, false);
      return `${anchor.file}:${anchor.line} (${anchor.side}): ${JSON.stringify(ref.quote.trim())}`;
    });
    return {
      severity: finding.severity, category: finding.category, file: source.file, line: source.line,
      detail: [finding.detail.trim(), `Evidence (${source.side}): ${JSON.stringify(finding.evidence.quote.trim())}.`,
        ...(related.length ? [`Related evidence: ${related.join('; ')}.`] : [])].join('\n'),
    };
  });
  return validateReview({ ...proposal, findings });
}
