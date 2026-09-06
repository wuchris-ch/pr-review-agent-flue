import * as v from 'valibot';

export const SeveritySchema = v.picklist(['blocker', 'major', 'minor', 'info']);
export const CategorySchema = v.picklist([
  'security',
  'correctness',
  'style',
  'performance',
]);

function isRepositoryRelativePath(file: string): boolean {
  if (file !== file.trim()) {
    return false;
  }

  const normalized = file.replaceAll('\\', '/');
  if (
    normalized === ''
    || normalized === '.'
    || normalized.startsWith('/')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
  ) {
    return false;
  }

  const segments = normalized.split('/');
  return segments.some((segment) => segment !== '' && segment !== '.')
    && segments.every((segment) => segment !== '..');
}

export const FindingSchema = v.strictObject({
  severity: SeveritySchema,
  category: CategorySchema,
  file: v.pipe(
    v.string(),
    v.nonEmpty('file must not be empty'),
    v.check(
      isRepositoryRelativePath,
      'file must be a repository-relative path without parent traversal',
    ),
  ),
  line: v.pipe(
    v.number(),
    v.integer('line must be an integer'),
    v.minValue(1, 'line must be positive'),
  ),
  detail: v.pipe(
    v.string(),
    v.check((detail) => detail.trim().length > 0, 'detail must not be blank'),
  ),
});

export const ReviewSchema = v.strictObject({
  schema_version: v.literal('1.0'),
  input_sha256: v.pipe(
    v.string(),
    v.regex(/^[a-f0-9]{64}$/, 'input_sha256 must be a lowercase SHA-256'),
  ),
  risk: v.picklist(['low', 'medium', 'high']),
  blocked: v.boolean(),
  findings: v.array(FindingSchema),
  rationale: v.pipe(
    v.string(),
    v.check(
      (rationale) => rationale.trim().length > 0,
      'rationale must not be blank',
    ),
  ),
});

export type Finding = v.InferOutput<typeof FindingSchema>;
export type Review = v.InferOutput<typeof ReviewSchema>;

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}

export function validateReview(value: unknown): Review {
  const parsed = v.safeParse(ReviewSchema, value);
  if (!parsed.success) {
    throw new ReviewValidationError('model output does not match review schema');
  }

  const hasBlockingFinding = parsed.output.findings.some(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  );

  if (parsed.output.blocked !== hasBlockingFinding) {
    throw new ReviewValidationError(
      'blocked must be true exactly when a blocker or major finding is present',
    );
  }

  const hasBlocker = parsed.output.findings.some(
    (finding) => finding.severity === 'blocker',
  );
  const hasMajor = parsed.output.findings.some(
    (finding) => finding.severity === 'major',
  );
  const expectedRisk = hasBlocker ? 'high' : hasMajor ? 'medium' : 'low';
  if (parsed.output.risk !== expectedRisk) {
    throw new ReviewValidationError(
      'risk must be high for blocker findings, medium for major-only findings, and low otherwise',
    );
  }

  return parsed.output;
}
