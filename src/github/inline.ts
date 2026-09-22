import { createHash } from 'node:crypto';
import { indexDiff } from '../core/diff/parse.js';
import { severityRank } from '../core/policy.js';
import type { RepositoryConfig } from '../core/repository-config.js';
import type { Finding, Review } from '../core/schema.js';
import { safeMarkdown } from '../render/github.js';
import type { ExistingComment, InlineComment } from './client.js';

export function findingKey(finding: Finding): string {
  // The primary allegation survives line movement; exact matching avoids suppressing unrelated bugs.
  return createHash('sha256')
    .update(
      JSON.stringify([
        finding.file,
        finding.category,
        finding.detail.split('\n')[0]?.trim().toLowerCase(),
      ]),
    )
    .digest('hex');
}

export function inlineComments(
  review: Review,
  diff: string,
  previous: readonly ExistingComment[],
  actor: string,
  config: RepositoryConfig,
): InlineComment[] {
  const anchors = indexDiff(diff)
    .flatMap((file) => file.hunks.flatMap((hunk) => hunk.anchors))
    .filter((anchor) => anchor.target);
  const comments: InlineComment[] = [];
  for (const finding of review.findings) {
    if (severityRank(finding.severity) > severityRank(config.minSeverity)) continue;
    const key = findingKey(finding);
    const marker = `<!-- pr-review-finding:${key} -->`;
    if (
      previous.some(
        (comment) =>
          comment.user.login === actor &&
          comment.line !== null &&
          comment.body.split('\n').includes(marker),
      )
    )
      continue;
    const anchor = anchors.find(
      (value) => value.file === finding.file && value.line === finding.line,
    );
    if (!anchor) throw new Error('finding has no publishable diff location');
    comments.push({
      path: finding.file,
      line: finding.line,
      side: anchor.side === 'head' ? 'RIGHT' : 'LEFT',
      body: `**${finding.severity.toUpperCase()} · ${finding.category}**\n\n${safeMarkdown(finding.detail)}\n\n${marker}`,
    });
  }
  return comments.slice(0, config.maxComments);
}
