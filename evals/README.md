# Evaluation

Use three separate signals: protocol correctness, behavior on authored scenarios, and usefulness on real PRs. Passing one does not imply the others.

## Authored checks

`npm test` verifies deterministic engine and transport contracts. `npm run examples:check` executes the scenario contracts without a model. `npm run eval:smoke`, `eval:full` and `eval:holdout` retain the original labelled diff suites. The historical holdout belongs to that authored suite; it is not the external benchmark below.

The full suite also includes four [repository-priority cases](priorities/README.md). Run only those with `node --env-file-if-exists=.env scripts/run-eval.mjs --set priorities`. Paired cases share the same diff but supply different operational or idempotency contracts; clean controls require zero findings.

```sh
npm run build
npm run eval:compare -- --arms single-pass,diff-pipeline,context-pipeline,context-validated --repeats 3
```

The comparison freezes inputs and uses the same configured model for every arm:

| Arm | Difference |
| --- | --- |
| `single-pass` | One grounded model review; no retrieval, deterministic detectors, second opinion or candidate validation |
| `diff-pipeline` | Static checks and the optional clean-change second opinion |
| `context-pipeline` | Adds unchanged repository context |
| `context-validated` | Adds a fresh validation of actual proposed findings |

Results land in ignored `evals/results/comparison-*/`. Each case has the complete review and stage record. `summary.json` records required-stage failures, latency, model calls, input bytes, provider-reported token usage, expected-location recall and false alarms on valid controls. Missing usage and dollar cost are `null`. Exact file/line hits are a reproducible development signal, not a semantic precision score. Compare arms per case and retain failed runs in the denominator.

## External PR benchmark

```sh
# Requires GitHub read access through gh auth or GITHUB_TOKEN. Makes no GitHub writes.
npm run eval:import -- --limit 10
npm run eval:compare -- --dataset external --limit 10 --arms single-pass,context-validated
```

The importer pins [Martian's public code review benchmark](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803) at `e616e849755441da38f18bf3adba2c9583b03803`. It supports all 50 PR references, freezes their current API base/head/merge-base IDs and diff bytes, retrieves bounded head context and retains the upstream MIT license. Files stay in ignored `evals/external/`. The default import limit is 50; `--limit 10` starts smaller. Interrupted imports resume existing immutable snapshots. keep that snapshot unchanged when comparing arms.

`gold.json` contains scoring annotations separately. The reviewer never loads those files, expected labels, later fixes or discussion threads. The comparison's external rows remain `adjudication: pending` until a reviewer judges whether each emitted finding is correct, actionable, introduced by the change, and equivalent to a gold issue. Gold comments include style and speculative observations; adjudicate against the [review priorities](../docs/guides/review-priorities.md) rather than rewarding every annotated comment.

For a held-out experiment, choose and freeze the evaluation split before prompt changes, group related PRs together, and reserve a separate development split. A public benchmark can have appeared in model training, so measure private or newly collected consenting-repository PRs before generalizing. Do not claim a benchmark win from the six development cases.

## Human feedback

Use `pr-review feedback` to record useful findings or false positives with reasons. Deduplicate repeated ratings per finding/input. Track confirmed finding precision, serious-defect recall, clean-PR false-positive rate, accepted-comment rate, latency, failure rate and reported tokens. Keep raw comments private and publish only reviewed aggregates. Promote a policy change only when it improves the chosen metric without unacceptable regressions on the others.
