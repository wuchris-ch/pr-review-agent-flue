const QUOTED_ESCAPE = /^\\([0-7]{3}|[\\"abfnrtv])/;
const NAMED_ESCAPES: Readonly<Record<string, number>> = {
  '\\': 0x5c,
  '"': 0x22,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in paths is the point.
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Decode the byte escapes Git uses inside a quoted path. */
function decodeQuotedPath(quoted: string): string {
  if (!quoted.endsWith('"')) {
    throw new Error('diff has an invalid quoted path');
  }

  const body = quoted.slice(1, -1);
  const bytes: number[] = [];

  for (let index = 0; index < body.length; ) {
    const matched = QUOTED_ESCAPE.exec(body.slice(index));
    if (matched) {
      const token = matched[1] as string;
      bytes.push(token.length === 3 ? Number.parseInt(token, 8) : (NAMED_ESCAPES[token] as number));
      index += matched[0].length;
      continue;
    }
    if (body[index] === '\\') {
      throw new Error('diff has an invalid quoted path');
    }
    const character = String.fromCodePoint(body.codePointAt(index) as number);
    bytes.push(...Buffer.from(character));
    index += character.length;
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

function isUnsafe(path: string): boolean {
  return (
    !path ||
    path !== path.trim() ||
    UNSAFE_PATH_CHARACTERS.test(path) ||
    path.startsWith('/') ||
    SCHEME_PREFIX.test(path) ||
    path.split('/').some((segment) => segment === '..' || segment === '.')
  );
}

/**
 * Read a repository-relative path out of a diff header.
 *
 * Returns undefined for `/dev/null`, which is how Git spells "this side
 * does not exist". Anything ambiguous or escaping the repository throws,
 * because a finding's location has to be trustworthy.
 */
export function pathFromHeader(raw: string): string | undefined {
  let path = raw.split('\t', 1)[0] ?? '';

  if (path.startsWith('"')) {
    path = decodeQuotedPath(path);
  }
  if (path === '/dev/null') {
    return undefined;
  }
  if (path.startsWith('a/') || path.startsWith('b/')) {
    path = path.slice(2);
  }
  if (isUnsafe(path)) {
    throw new Error('diff path must be repository-relative and unambiguous');
  }
  return path;
}
