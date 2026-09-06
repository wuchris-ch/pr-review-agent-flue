export interface DiffPartition {
  text: string;
  files: ReadonlySet<string>;
}

function normalizeDiffPath(rawPath: string): string | undefined {
  const path = rawPath.trim();
  if (!path || path === '/dev/null' || path.startsWith('"')) {
    return undefined;
  }
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

export function extractDiffPaths(text: string): ReadonlySet<string> {
  const paths = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const path = normalizeDiffPath(line.slice(4).split('\t', 1)[0] ?? '');
      if (path) {
        paths.add(path);
      }
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match?.[2] ? normalizeDiffPath(`b/${match[2]}`) : undefined;
      if (path) {
        paths.add(path);
      }
    }
  }

  return paths;
}

function fileSections(text: string): string[] {
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) {
    return [text];
  }

  const sections: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = index === 0 ? 0 : starts[index];
    const end = starts[index + 1] ?? text.length;
    if (start !== undefined) {
      sections.push(text.slice(start, end));
    }
  }
  return sections;
}

export function partitionDiff(
  text: string,
  maxPartitionBytes: number,
): DiffPartition[] {
  if (!Number.isSafeInteger(maxPartitionBytes) || maxPartitionBytes <= 0) {
    throw new Error('diff partition limit must be a positive integer');
  }

  const sections = fileSections(text);
  const partitions: DiffPartition[] = [];
  let pending = '';

  const commitPending = (): void => {
    if (pending) {
      partitions.push({ text: pending, files: extractDiffPaths(pending) });
      pending = '';
    }
  };

  for (const section of sections) {
    if (Buffer.byteLength(section, 'utf8') > maxPartitionBytes) {
      throw new Error(
        'a single diff file exceeds the agent message limit; split the change into a smaller patch',
      );
    }

    const candidate = `${pending}${section}`;
    if (pending && Buffer.byteLength(candidate, 'utf8') > maxPartitionBytes) {
      commitPending();
    }
    pending += section;
  }
  commitPending();

  return partitions;
}
