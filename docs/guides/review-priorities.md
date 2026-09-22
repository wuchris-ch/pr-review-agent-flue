# Review priorities

The reviewer looks for defects that affect this repository's users, data, security, availability, or operating cost. It first identifies the applicable contracts in supplied guidance, source, callers, tests, configuration, and documentation. It then checks how the change could violate them.

| Area | What makes a finding actionable |
| --- | --- |
| Security and privacy | A reachable path across an authorization, tenant, input, secret, or privilege boundary, accounting for existing defenses |
| Correctness and reliability | A supported input or failure path produces wrong results, invalid state, duplicate effects, data loss, or unavailable service |
| Performance and resources | A changed operation increases work or resource use on supported workloads, with an identified size/frequency condition and mechanism |
| Compatibility and delivery | A supported caller, persisted format, configuration, migration, or deployment contract breaks |

The model must explain the trigger, consequence, source evidence, and practical fix. It compares the same triggering input and state before and after the change, rejecting allegations whose failure behavior is unchanged. It must not invent traffic levels, capacity limits, benchmarks, or compatibility promises. Formatting, naming, micro-optimizations, generic refactoring, and requests for more tests are not findings by themselves. A small real defect can still be reported with proportionate severity.

## Tell the reviewer what matters here

Add a few concrete invariants to the `rules` array in `.pr-review.json`. State the affected component, required behavior, known limits, and intentional exceptions. For example:

```json
{
  "version": 1,
  "rules": [
    "In src/orders/, cache hits must enforce the same tenant boundary as database reads; order IDs are unique only within a tenant.",
    "In src/exports/, batches support up to 10000 records. The database pool has 32 connections shared with requests, so export concurrency must remain bounded below that limit.",
    "In src/payments/, webhook delivery is at least once. Recording an event ID and applying its balance change must be atomic; identical amounts with different event IDs are distinct payments.",
    "Public API v1 consumers depend on the documented response field names and cursor semantics. Breaking changes belong in a new version.",
    "Optional analytics delivery may fail without failing checkout. Payment authorization failures must never be converted into a successful checkout."
  ]
}
```

Replace these examples with verified facts about your repository. A statement such as “check performance” does not establish a workload or a limit. Narrow rules make both defects and valid design choices easier to distinguish. Paths inside a rule are natural-language scope interpreted by the model; they are not an additional glob configuration field.

Root `AGENTS.md` also supplies repository guidance. GitHub reviews load configuration and guidance from the PR's base revision, so rules added by the PR take effect after merge. Local reviews read the checkout's guidance. Raw diffs can use `pr-review agent --diff change.diff --instructions review-contracts.md`. Guidance can describe intended contracts but cannot suppress supported defects or override the review protocol. See [configuration](configuration.md) for settings and limits.

## Where the behavior lives

- [`src/agents/system-prompt.ts`](../../src/agents/system-prompt.ts): shared priorities, evidence requirements, severity, and JSON contract for all model passes.
- [`src/stages/review-message.ts`](../../src/stages/review-message.ts): per-request task, repository guidance, and anchored source.
- [`src/review-service.ts`](../../src/review-service.ts): second-opinion task and stage selection.
- [`src/stages/validate-findings.ts`](../../src/stages/validate-findings.ts): independent challenge of candidate findings, including repository impact and workload assumptions.
- [`src/core/policy.ts`](../../src/core/policy.ts): deterministic severity-to-verdict rules. Changing prose does not change these rules.

The GitHub review policy version is advanced when review behavior changes, preventing an older review receipt from satisfying the new policy on the same PR revision.

## Research basis

Sources checked September 21, 2026:

- [Google's review guide](https://google.github.io/eng-practices/review/reviewer/looking-for.html) calls for understanding the wider system, user impact, concurrency, and surrounding code. This informs the contract-first review process.
- [OWASP's secure review guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html) starts with architecture, business requirements, assets, and trust boundaries, then traces data flow through changed controls. This informs the requirement for a reachable security impact.
- [CodeRabbit's path instructions](https://docs.coderabbit.ai/configuration/path-instructions) document targeted repository guidance as a supplement to general review. This informs scoped rules and documented exceptions rather than a universal checklist.
- [Lin et al., July 2026, v2](https://arxiv.org/abs/2607.03316v2) studied developer responses to CodeRabbit comments and identified false positives, redundancy, scope, and intent mismatches among rejection reasons. This informs the finding-quality filters; it does not measure this reviewer.

## Check the behavior

```sh
npm run build
node --env-file-if-exists=.env scripts/run-eval.mjs --set priorities
```

The four [paired contract cases](../../evals/priorities/README.md) review identical changes under different repository constraints: large versus bounded batches, and append-only versus idempotent delivery. Unit tests execute both versions to verify the underlying behavior. The live model evaluation checks findings and clean controls, with labels kept out of review requests. These are focused development checks, not a broad accuracy benchmark.
