import * as v from 'valibot';
import { parseStrictJson } from './json.js';

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));
const schema = v.strictObject({
  version: v.literal(1),
  rules: v.optional(v.pipe(v.array(text), v.maxLength(20)), []),
  exclude: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(256))), v.maxLength(40)),
    [],
  ),
  context: v.optional(v.boolean(), true),
  validateFindings: v.optional(v.boolean(), true),
  maxComments: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 8),
  minSeverity: v.optional(v.picklist(['blocker', 'major', 'minor', 'info']), 'minor'),
  failOnFindings: v.optional(v.boolean(), false),
  autoReview: v.optional(v.boolean(), true),
});

export type RepositoryConfig = v.InferOutput<typeof schema>;
export const DEFAULT_REPOSITORY_CONFIG: RepositoryConfig = v.parse(schema, { version: 1 });

/** Configuration cannot provide commands, endpoints, credentials or model instructions of authority. */
export function parseRepositoryConfig(text: string | undefined): RepositoryConfig {
  if (text === undefined) return { ...DEFAULT_REPOSITORY_CONFIG, rules: [], exclude: [] };
  if (Buffer.byteLength(text) > 16 * 1024)
    throw new Error('repository configuration exceeds 16 KiB');
  const result = v.safeParse(schema, parseStrictJson(text));
  if (!result.success)
    throw new Error('invalid .pr-review.json; check the configuration reference');
  return result.output;
}

/** Deliberately small glob syntax: *, ** and ?. Patterns are repository-relative. */
export function pathMatches(path: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (j === pattern.length) result = i === path.length;
    else if (pattern.startsWith('**/', j))
      result =
        match(i, j + 3) ||
        (i < path.length && ((path[i] === '/' && match(i + 1, j + 3)) || match(i + 1, j)));
    else if (pattern.startsWith('**', j))
      result = match(i, j + 2) || (i < path.length && match(i + 1, j));
    else if (pattern[j] === '*')
      result = match(i, j + 1) || (i < path.length && path[i] !== '/' && match(i + 1, j));
    else
      result =
        i < path.length &&
        (pattern[j] === path[i] || (pattern[j] === '?' && path[i] !== '/')) &&
        match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export function excluded(path: string, config: RepositoryConfig): boolean {
  return config.exclude.some((pattern) => pathMatches(path, pattern));
}
