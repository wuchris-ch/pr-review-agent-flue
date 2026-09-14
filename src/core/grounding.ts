import * as v from 'valibot';
import type { EvidencePacket, SourceAnchor } from './diff/types.js';
import { parseStrictJson } from './json.js';
import { CategorySchema, type Review, SeveritySchema, validateReview } from './schema.js';

export const MAX_FINDINGS = 32;
export const MAX_RELATED_CITATIONS = 3;

const EvidenceReferenceSchema = v.strictObject({
  anchor: v.string(),
  quote: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
});

/** What the model is allowed to return, before the application resolves locations. */
const ProposalSchema = v.strictObject({
  schema_version: v.literal('1.0'),
  input_sha256: v.string(),
  risk: v.picklist(['low', 'medium', 'high']),
  blocked: v.boolean(),
  findings: v.pipe(
    v.array(
      v.strictObject({
        severity: SeveritySchema,
        category: CategorySchema,
        evidence: EvidenceReferenceSchema,
        related: v.optional(
          v.pipe(v.array(EvidenceReferenceSchema), v.maxLength(MAX_RELATED_CITATIONS)),
          [],
        ),
        detail: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
      }),
    ),
    v.maxLength(MAX_FINDINGS),
  ),
  rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});

type EvidenceReference = v.InferOutput<typeof EvidenceReferenceSchema>;

export class EvidenceValidationError extends Error {}
export class DigestValidationError extends Error {}

/**
 * Resolve one citation against the anchors that were actually supplied.
 *
 * A primary citation must point at a line the model is allowed to blame,
 * and every citation must quote that line exactly. This is what stops a
 * finding from being attached to a location the diff does not support.
 */
function resolveCitation(
  reference: EvidenceReference,
  packet: EvidencePacket,
  primary: boolean,
): SourceAnchor {
  const anchor = packet.anchors.get(reference.anchor);
  const quote = reference.quote.trim();
  const unusable =
    !anchor ||
    (primary && !packet.targets.has(reference.anchor)) ||
    !quote ||
    quote.includes('\n') ||
    !anchor.text.includes(quote) ||
    (quote.length < 3 && quote !== anchor.text.trim());

  if (unusable) {
    throw new EvidenceValidationError(
      'finding evidence must quote an exact supplied source anchor',
    );
  }
  return anchor as SourceAnchor;
}

function describeRelated(anchor: SourceAnchor, quote: string): string {
  return `${anchor.file}:${String(anchor.line)} (${anchor.side}): ${JSON.stringify(quote)}`;
}

/**
 * Turn a model proposal into a review whose locations the application owns.
 *
 * The model chooses an anchor; every file path and line number in the result
 * comes from the diff index, never from the model.
 */
export function groundReview(text: string, packet: EvidencePacket, digest: string): Review {
  const parsed = v.safeParse(ProposalSchema, parseStrictJson(text));
  if (!parsed.success) {
    throw new EvidenceValidationError('model output does not match the evidence contract');
  }

  const proposal = parsed.output;
  if (proposal.input_sha256 !== digest) {
    throw new DigestValidationError('model output input_sha256 does not match the reviewed diff');
  }

  const findings = proposal.findings.map((finding) => {
    const source = resolveCitation(finding.evidence, packet, true);
    const related = finding.related.map((reference) =>
      describeRelated(resolveCitation(reference, packet, false), reference.quote.trim()),
    );

    return {
      severity: finding.severity,
      category: finding.category,
      file: source.file,
      line: source.line,
      detail: [
        finding.detail.trim(),
        `Evidence (${source.side}): ${JSON.stringify(finding.evidence.quote.trim())}.`,
        ...(related.length ? [`Related evidence: ${related.join('; ')}.`] : []),
      ].join('\n'),
    };
  });

  return validateReview({ ...proposal, findings });
}
