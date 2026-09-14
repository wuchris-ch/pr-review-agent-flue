import { pathFromHeader } from './paths.js';
import type { EvidenceFile, EvidenceHunk, SourceAnchor } from './types.js';

const FILE_SECTION = /(?=^diff --git )/m;
const GIT_HEADER = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const NO_NEWLINE = '\\ No newline at end of file';
const SOURCE_PREFIXES = [' ', '+', '-'];

interface FilePaths {
  oldPath: string | undefined;
  newPath: string | undefined;
  path: string;
}

interface HunkSpan {
  oldLine: number;
  newLine: number;
  oldCount: number;
  newCount: number;
}

/** Walks a file section one line at a time. */
class LineCursor {
  private index = 0;

  constructor(private readonly lines: readonly string[]) {}

  seek(index: number): void {
    this.index = index;
  }

  atEnd(): boolean {
    // A trailing empty line from the final newline is not a source line.
    return (
      this.index >= this.lines.length ||
      (this.index === this.lines.length - 1 && this.peek() === '')
    );
  }

  peek(): string | undefined {
    return this.lines[this.index];
  }

  take(): string | undefined {
    return this.lines[this.index++];
  }

  skipIf(value: string): void {
    if (this.peek() === value) {
      this.index += 1;
    }
  }
}

function resolveFilePaths(headers: readonly string[]): FilePaths {
  const gitHeader = GIT_HEADER.exec(headers[0] ?? '');
  const gitOld = gitHeader ? pathFromHeader(gitHeader[1] as string) : undefined;
  const gitNew = gitHeader ? pathFromHeader(gitHeader[2] as string) : undefined;

  const oldHeader = headers.find((line) => line.startsWith('--- '));
  const newHeader = headers.find((line) => line.startsWith('+++ '));
  const oldPath = oldHeader ? pathFromHeader(oldHeader.slice(4)) : gitOld;
  const newPath = newHeader ? pathFromHeader(newHeader.slice(4)) : gitNew;

  if ((oldPath && gitOld && oldPath !== gitOld) || (newPath && gitNew && newPath !== gitNew)) {
    throw new Error('diff file headers disagree');
  }

  const path = newPath ?? oldPath;
  if (!path) {
    throw new Error('diff contains missing or duplicate file paths');
  }
  return { oldPath, newPath, path };
}

function parseHunkHeader(header: string): HunkSpan {
  const match = HUNK_HEADER.exec(header);
  if (!match) {
    throw new Error('diff has an invalid or unsupported hunk header');
  }

  const span: HunkSpan = {
    oldLine: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newLine: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };

  const bounds = [
    span.oldLine,
    span.newLine,
    span.oldCount,
    span.newCount,
    span.oldLine + span.oldCount,
    span.newLine + span.newCount,
  ];
  if (
    !bounds.every(Number.isSafeInteger) ||
    (span.oldCount > 0 && span.oldLine < 1) ||
    (span.newCount > 0 && span.newLine < 1)
  ) {
    throw new Error('diff has invalid hunk coordinates');
  }
  return span;
}

interface HunkContext {
  fileIndex: number;
  paths: FilePaths;
  seen: Set<string>;
}

interface SourceLine {
  kind: string;
  text: string;
}

/** The next real source line, skipping Git's no-newline notice. */
function nextSourceLine(cursor: LineCursor): SourceLine {
  for (;;) {
    const source = cursor.take();
    if (source === NO_NEWLINE) {
      continue;
    }
    if (source === undefined || !SOURCE_PREFIXES.includes(source[0] ?? '')) {
      throw new Error('diff hunk is truncated or its counts do not match');
    }
    return { kind: source[0] as string, text: source.slice(1) };
  }
}

function anchorFor(line: SourceLine, number: number, context: HunkContext): SourceAnchor {
  const side = line.kind === '-' ? 'base' : 'head';
  const id = `F${String(context.fileIndex + 1)}${side === 'head' ? 'N' : 'O'}${String(number)}`;
  if (context.seen.has(id)) {
    throw new Error('diff hunks overlap and cannot be mapped unambiguously');
  }
  context.seen.add(id);

  return {
    id,
    file: side === 'base' ? (context.paths.oldPath ?? context.paths.path) : context.paths.path,
    line: number,
    side,
    text: line.text,
    target: line.kind === '+',
  };
}

function parseHunkBody(
  cursor: LineCursor,
  header: string,
  span: HunkSpan,
  context: HunkContext,
): EvidenceHunk {
  const anchors: SourceAnchor[] = [];
  const rendered = [header];
  let { oldLine, newLine } = span;
  let oldRemaining = span.oldCount;
  let newRemaining = span.newCount;
  let additions = 0;

  while (oldRemaining > 0 || newRemaining > 0) {
    const line = nextSourceLine(cursor);
    const anchor = anchorFor(line, line.kind === '-' ? oldLine : newLine, context);
    anchors.push(anchor);
    rendered.push(`${line.kind} [${anchor.id}] ${anchor.text}`);

    if (line.kind !== '+') {
      oldLine += 1;
      oldRemaining -= 1;
    }
    if (line.kind !== '-') {
      newLine += 1;
      newRemaining -= 1;
    }
    if (line.kind === '+') {
      additions += 1;
    }
    if (oldRemaining < 0 || newRemaining < 0) {
      throw new Error('diff hunk counts do not match');
    }
  }

  cursor.skipIf(NO_NEWLINE);

  // A pure deletion has no added line. Keep its base-side provenance rather
  // than inventing a head location for the finding.
  if (additions === 0) {
    for (const anchor of anchors) {
      anchor.target = anchor.side === 'base';
    }
  }

  return { text: rendered.join('\n'), anchors };
}

function parseFileSection(section: string, fileIndex: number): EvidenceFile {
  const lines = section.split(/\r?\n/);
  const headerEnd = lines.findIndex((line) => line.startsWith('@@'));
  const headers = headerEnd < 0 ? lines : lines.slice(0, headerEnd);

  if (headers.some((line) => line === 'GIT binary patch' || line.startsWith('Binary files '))) {
    throw new Error('binary changes require a separate review; no text verdict was produced');
  }

  const paths = resolveFilePaths(headers);
  const context: HunkContext = { fileIndex, paths, seen: new Set() };
  const cursor = new LineCursor(lines);
  cursor.seek(headerEnd < 0 ? lines.length : headerEnd);

  const hunks: EvidenceHunk[] = [];
  let previousOldEnd = 0;
  let previousNewEnd = 0;

  while (!cursor.atEnd()) {
    const header = cursor.take() as string;
    const span = parseHunkHeader(header);
    if (span.oldLine < previousOldEnd || span.newLine < previousNewEnd) {
      throw new Error('diff hunks overlap or are out of order');
    }
    previousOldEnd = span.oldLine + span.oldCount;
    previousNewEnd = span.newLine + span.newCount;
    hunks.push(parseHunkBody(cursor, header, span, context));
  }

  const looksLikeSource = (line: string): boolean =>
    /^[+\- ]/.test(line) && !line.startsWith('--- ') && !line.startsWith('+++ ');
  if (hunks.length === 0 && headers.some(looksLikeSource)) {
    throw new Error('changed source is missing a unified diff hunk header');
  }

  return {
    path: paths.path,
    hunks,
    text: [
      `File: ${JSON.stringify(paths.path)}`,
      ...headers,
      ...hunks.map((hunk) => hunk.text),
    ].join('\n'),
  };
}

/**
 * Map every diff line to an exact file, line, and side before any model call.
 *
 * The model later cites an anchor identifier and the application resolves
 * the location, so a finding can never point somewhere the diff does not.
 */
export function indexDiff(text: string): EvidenceFile[] {
  const sections = text.split(FILE_SECTION).filter((part) => part.trim());
  const files: EvidenceFile[] = [];
  const paths = new Set<string>();

  for (const [fileIndex, section] of sections.entries()) {
    const file = parseFileSection(section, fileIndex);
    if (paths.has(file.path)) {
      throw new Error('diff contains missing or duplicate file paths');
    }
    paths.add(file.path);
    files.push(file);
  }

  if (files.length === 0) {
    throw new Error('diff contains no reviewable files');
  }
  return files;
}
