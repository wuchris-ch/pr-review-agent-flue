import type { SourceAnchor } from '../core/diff/types.js';
import type { Category, Finding, Severity } from '../core/schema.js';
import type { ReviewContext, ReviewStage, StageResult } from './types.js';

/**
 * Deterministic detectors that cost nothing to run.
 *
 * These exist to catch the small set of defects that have an exact textual
 * signature, so the model is not the only thing standing between a leaked
 * credential and a merge. Every detector reads the same indexed anchors the
 * model sees, so findings carry real file and line numbers with no
 * grounding step required.
 *
 * The bar for adding one: it must be nearly impossible to express
 * accidentally, or the false-positive cost swamps the benefit.
 */
export interface StaticDetector {
  readonly id: string;
  readonly severity: Severity;
  readonly category: Category;
  readonly pattern: RegExp;
  readonly detail: string;
  /** Return true to suppress a match, for placeholders and indirection. */
  readonly ignore?: (line: string) => boolean;
  /** Restrict the detector to files whose path matches. */
  readonly paths?: RegExp;
}

const PLACEHOLDER =
  /(process\.env|os\.environ|getenv|secrets\.|vault|\$\{|<[a-z_-]+>|xxx+|changeme|example|placeholder|dummy|redacted|\*\*\*)/i;

const COMMENT_PREFIX = /^\s*(#|\/\/|\*|--|<!--)/;

export const DEFAULT_DETECTORS: readonly StaticDetector[] = [
  {
    id: 'private-key-literal',
    severity: 'blocker',
    category: 'security',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    detail:
      'A private key block is committed in the diff. Revoke and rotate the key, remove it from the change, and load it from a secret store at runtime.',
  },
  {
    id: 'aws-access-key-id',
    severity: 'blocker',
    category: 'security',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    detail:
      'An AWS access key identifier is hardcoded in the diff. Revoke the key pair and read credentials from the environment or an instance role instead.',
  },
  {
    id: 'hardcoded-credential',
    severity: 'blocker',
    category: 'security',
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    detail:
      'A credential is assigned from a literal in the diff. Rotate the value and read it from the environment or a secret store.',
    ignore: (line) => PLACEHOLDER.test(line),
  },
  {
    id: 'disabled-tls-verification',
    severity: 'blocker',
    category: 'security',
    pattern:
      /(verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:0|false))/i,
    detail:
      'Transport certificate verification is disabled, which removes protection against an active network attacker. Keep verification on and supply the trusted CA bundle instead.',
  },
  {
    id: 'remote-script-execution',
    severity: 'major',
    category: 'security',
    pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/,
    detail:
      'A remote script is piped straight into a shell, so the build executes whatever the endpoint serves at that moment. Pin and verify the artifact before running it.',
  },
  {
    id: 'workflow-write-all',
    severity: 'major',
    category: 'security',
    paths: /^\.github\/workflows\/[^/]+\.ya?ml$/,
    pattern: /permissions\s*:\s*write-all/,
    detail:
      'The workflow grants write-all permissions, so any step can push code or publish releases with the repository token. Grant only the specific scopes the jobs need.',
  },
];

function matches(detector: StaticDetector, anchor: SourceAnchor): boolean {
  if (detector.paths && !detector.paths.test(anchor.file)) {
    return false;
  }
  if (COMMENT_PREFIX.test(anchor.text)) {
    return false;
  }
  if (!detector.pattern.test(anchor.text)) {
    return false;
  }
  return !detector.ignore?.(anchor.text);
}

/** Added lines only, deduplicated across partitions that share a related hunk. */
function targetAnchors(context: ReviewContext): SourceAnchor[] {
  const unique = new Map<string, SourceAnchor>();
  for (const packet of context.packets) {
    for (const id of packet.targets) {
      const anchor = packet.anchors.get(id);
      if (anchor?.side === 'head') {
        unique.set(`${anchor.file}:${String(anchor.line)}`, anchor);
      }
    }
  }
  return [...unique.values()];
}

export function createStaticStage(
  detectors: readonly StaticDetector[] = DEFAULT_DETECTORS,
): ReviewStage {
  return {
    name: 'static-checks',
    costClass: 'free',
    shouldRun: () => true,
    run(context): Promise<StageResult> {
      const startedAt = Date.now();
      const findings: Finding[] = [];

      for (const anchor of targetAnchors(context)) {
        for (const detector of detectors) {
          if (!matches(detector, anchor)) {
            continue;
          }
          findings.push({
            severity: detector.severity,
            category: detector.category,
            file: anchor.file,
            line: anchor.line,
            detail: `${detector.detail}\nDetected by the ${detector.id} static check on the added line.`,
          });
        }
      }

      return Promise.resolve({
        stage: 'static-checks',
        status: 'ran',
        findings,
        notes: findings.length
          ? [
              findings.length === 1
                ? 'A deterministic check matched one known-defect pattern.'
                : `Deterministic checks matched ${String(findings.length)} known-defect patterns.`,
            ]
          : [],
        durationMs: Date.now() - startedAt,
      });
    },
  };
}
