import type { Review } from '../core/schema.js';

export const MAX_REVIEW_BODY_BYTES = 60 * 1024;

/**
 * Escape text that came from a diff or a model before it lands in a GitHub
 * comment, so it cannot mention users or inject formatting.
 */
function safeMarkdown(value: string): string {
  return value
    .replaceAll('@', '@\u200b')
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function inlineCode(value: string): string {
  const longestRun = (value.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  const padding = longestRun > 0 ? ' ' : '';
  const body = value.replaceAll('\n', ' ').replaceAll('\r', ' ');
  return `${fence}${padding}${body}${padding}${fence}`;
}

export function formatGitHubReview(review: Review): string {
  const lines = [
    '## PR review agent',
    '',
    `**Risk:** ${review.risk}  `,
    `**Blocking findings:** ${review.blocked ? 'yes' : 'no'}`,
    '',
  ];

  if (review.findings.length === 0) {
    lines.push('No findings.', '');
  } else {
    lines.push('### Findings', '');
    for (const [index, finding] of review.findings.entries()) {
      const location = inlineCode(`${finding.file}:${String(finding.line)}`);
      lines.push(
        `${String(index + 1)}. **${finding.severity.toUpperCase()} · ${finding.category}** at ${location}`,
        `   ${safeMarkdown(finding.detail)}`,
        '',
      );
    }
  }

  lines.push('### Rationale', '', safeMarkdown(review.rationale), '');
  return lines.join('\n');
}
