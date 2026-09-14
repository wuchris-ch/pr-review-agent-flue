import type { EvidenceFile, EvidenceHunk, EvidencePacket, SourceAnchor } from './types.js';

export const MAX_CONTEXT_BYTES = 16 * 1024;
export const MAX_CONTEXT_HUNKS = 4;
export const MAX_PARTITIONS = 24;
const PACKET_HEADER_RESERVE_BYTES = 256;

const COMMON_WORDS = new Set(
  `const let var return def function class export import from if else elif try except catch throw
   raise new true false null none self this async await int str string number bool boolean public
   private void for while with and or not in is as to of on id data value name result error`
    .split(/\s+/)
    .filter(Boolean),
);

/** Identifiers worth matching on, ignoring language keywords that appear everywhere. */
function symbols(text: string): Set<string> {
  const words = text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  return new Set(words.filter((word) => !COMMON_WORDS.has(word.toLowerCase())));
}

/** Split files into groups that each fit one agent message. */
function groupFiles(files: readonly EvidenceFile[], budget: number): EvidenceFile[][] {
  const groups: EvidenceFile[][] = [];
  let group: EvidenceFile[] = [];
  let bytes = 0;

  for (const file of files) {
    const size = Buffer.byteLength(file.text) + 2;
    if (size > budget) {
      throw new Error(
        'a single diff file exceeds the agent message limit; split the change into a smaller patch',
      );
    }
    if (bytes + size > budget) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(file);
    bytes += size;
  }

  if (group.length) {
    groups.push(group);
  }
  if (groups.length > MAX_PARTITIONS) {
    throw new Error('diff exceeds the review partition budget');
  }
  return groups;
}

interface Candidate {
  file: EvidenceFile;
  hunk: EvidenceHunk;
  score: number;
}

/** Hunks from other partitions that share identifiers with this one, best first. */
function relatedHunks(
  files: readonly EvidenceFile[],
  targets: readonly EvidenceFile[],
): Candidate[] {
  const wanted = symbols(targets.map((file) => file.text).join('\n'));
  return files
    .filter((file) => !targets.includes(file))
    .flatMap((file) =>
      file.hunks.map((hunk) => ({
        file,
        hunk,
        score: [...symbols(hunk.text)].filter((word) => wanted.has(word)).length,
      })),
    )
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path),
    );
}

function buildPacket(
  files: readonly EvidenceFile[],
  targets: readonly EvidenceFile[],
  maxBytes: number,
): EvidencePacket {
  const anchors = new Map<string, SourceAnchor>();
  const targetIds = new Set<string>();

  for (const file of targets) {
    for (const hunk of file.hunks) {
      for (const anchor of hunk.anchors) {
        anchors.set(anchor.id, anchor);
        if (anchor.target) {
          targetIds.add(anchor.id);
        }
      }
    }
  }

  const context: string[] = [];
  let contextBytes = 0;
  for (const { file, hunk } of relatedHunks(files, targets)) {
    if (context.length >= MAX_CONTEXT_HUNKS) {
      break;
    }
    const rendered = `Related context only, file ${JSON.stringify(file.path)}:\n${hunk.text}`;
    const size = Buffer.byteLength(rendered) + 2;
    if (contextBytes + size > MAX_CONTEXT_BYTES) {
      continue;
    }
    context.push(rendered);
    contextBytes += size;
    for (const anchor of hunk.anchors) {
      anchors.set(anchor.id, anchor);
    }
  }

  const text = [
    'Target files (findings must anchor to a + line, or a removed line in a deletion-only hunk):',
    ...targets.map((file) => file.text),
    ...(context.length
      ? [
          'Related hunks are read-only evidence. Report their own defects in their target partition.',
          ...context,
        ]
      : []),
  ].join('\n\n');

  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error('source evidence exceeds the message budget');
  }
  return { text, anchors, targets: targetIds, retrievedHunks: context.length };
}

/**
 * Pack indexed files into agent-sized partitions.
 *
 * Retrieval never leaves the supplied diff: related hunks come from other
 * partitions of the same change and stay read-only evidence, so a review
 * cannot depend on repository state the caller did not provide.
 */
export function evidencePackets(files: EvidenceFile[], maxBytes: number): EvidencePacket[] {
  const budget = maxBytes - MAX_CONTEXT_BYTES - PACKET_HEADER_RESERVE_BYTES;
  if (budget <= 0) {
    throw new Error('review guidance leaves no room for source evidence');
  }
  return groupFiles(files, budget).map((targets) => buildPacket(files, targets, maxBytes));
}
