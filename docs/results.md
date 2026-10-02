# Results

Measured October 1, 2026 (America/Vancouver). Every number below comes from files in this repository; commands to reproduce them are at the end.

## Summary

- **Public benchmark.** On the 30 held-out pull requests of a 50-PR public benchmark, the final reviewer found 33 of 110 human-verified issues at 52.4% precision (F1 38.2%), up from 28 issues at 53.8% precision (F1 34.6%) for the baseline with the same model. Among 18 reviewers scored by the same judge (17 published commercial tools plus this one), it ranks 7th on precision and 15th on F1: it is precise, and its recall remains well below the leaders.
- **Regression platform with a live model.** Across three runs over three seeded multi-file regressions and three valid alternative changes, it reproduced 9 of 9 regressions with failing tests, every proposed fix passed contract tests the agents never saw (9 of 9), and it flagged 0 of 9 valid changes.

## Public benchmark: 50 real pull requests

**Dataset.** [Martian's offline code review benchmark](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803/offline), pinned at `e616e84`: 50 pull requests from Sentry, Grafana, Keycloak, Discourse and Cal.com with 173 human-verified issues ("golden comments"), 158 of them in the default *core* profile (bugs, security, concurrency, data, API, performance, test gaps and documentation defects). The reviewer never sees the golden comments, later fixes or discussion.

**Scoring.** An LLM judge decides whether each review comment describes the same underlying issue as a golden comment. Precision is matched comments over all comments, recall is found issues over all issues, and F1 combines them. Martian scores tools with GPT-5.2, which is not available through the ChatGPT subscription used here, so [`evals/martian/judge.py`](../evals/martian/judge.py) applies the same matching rule with one batched call per PR and tool (gpt-5.5, medium effort). Re-scoring the 17 published tools whose extracted comments Martian publishes, this judge agreed with Martian's published GPT-5.2 decisions on **95.5% of 2,941 golden-comment decisions (Cohen's kappa 0.91)**, and tool-level F1 typically lands within a few points of the published values. All tools below, including this reviewer, are scored by the same judge.

**Development and held-out split.** Before any change, the 50 PRs were split by a hash of their ID into 20 development PRs (4 per repository) and 30 held-out PRs ([`evals/martian/split.json`](../evals/martian/split.json)). Changes were chosen by looking at development PRs only. The final version ran once on the held-out PRs.

**Model.** gpt-6.1-sol at high reasoning effort for every reviewer arm, through an OpenAI-compatible endpoint.

### Held-out results (30 PRs, core profile)

| Rank | Reviewer | F1 | Precision | Recall |
|---:|---|---:|---:|---:|
| 1 | Qodo (extended) | 66.0% | 68.6% | 63.6% |
| 2 | Augment | 59.3% | 54.1% | 65.5% |
| 3 | Qodo | 55.3% | 50.0% | 61.8% |
| 4 | Cursor Bugbot | 51.5% | 55.2% | 48.2% |
| 5 | GitLab Duo | 50.7% | 51.4% | 50.0% |
| 6 | Gemini | 50.4% | 45.6% | 56.4% |
| 7 | Devin | 49.5% | 62.5% | 40.9% |
| 8 | GitHub Copilot (v2) | 49.0% | 38.5% | 67.3% |
| 9 | Greptile v4.1 | 48.1% | 49.1% | 47.3% |
| 10 | Macroscope | 47.0% | 52.2% | 42.7% |
| 11 | GitHub Copilot | 43.2% | 34.0% | 59.1% |
| 12 | Claude | 42.4% | 47.7% | 38.2% |
| 13 | CodeRabbit | 42.0% | 31.8% | 61.8% |
| 14 | Baz | 41.7% | 50.6% | 35.5% |
| 15 | **pr-review-agent (final)** | 38.2% | 52.4% | 30.0% |
| 16 | **pr-review-agent (baseline)** | 34.6% | 53.8% | 25.5% |
| 17 | CodeAnt | 31.6% | 29.8% | 33.6% |
| 18 | KG | 28.8% | 69.0% | 18.2% |
| 19 | Graphite | 13.3% | 80.0% | 7.3% |

Strict profile (bugs, security, concurrency, data and API only): final 38.8% F1 (51.6% precision, 31.1% recall) against 34.0% for the baseline.

Five published tools (cubic, Kodus, Sourcery, Claude Code and Greptile v5) are omitted: Martian publishes their extracted comments for at most one PR, so they cannot be re-scored comparably.

### What changed, and how each change was decided

The baseline reviewer was precise but quiet. It reported about one finding per PR while the golden set averages three, and its recall was 22% on all 50 PRs. Scoring its unfiltered drafts showed that evidence validation discarded few drafts; the main pass simply never proposed most issues. Development experiments:

| Development version (20 PRs) | Precision | Recall | F1 | Decision |
|---|---:|---:|---:|---|
| Baseline | 38.9% | 14.6% | 21.2% | |
| One broad defect-hunting pass | 28.1% | 18.8% | 22.5% | Rejected: false positives doubled |
| Three focused hunts (logic, state, contracts) | 20.0% | 21.7% | 20.8% | Rejected (19 PRs scored); available behind `REVIEW_HUNT_STAGES`, off by default |
| Whole changed files in repository context | 35.7% | 20.8% | 26.3% | Kept |
| Plus: report concrete defects in code the PR edits | 42.4% | 29.2% | 34.6% | Kept, then frozen for the held-out run |

1. **Whole changed files in context.** Many misses needed the rest of the file: for example, a Keycloak cache method that calls back into the same caching layer instead of its delegate. The reviewer previously saw diff hunks plus at most 12 KiB of identifier-matched excerpts. Changed files now come first and appear whole when they fit, within a 40 KiB context budget that never displaces diff text.
2. **Edited defective code is in scope.** The reviewer deliberately ignored weaknesses that existed before the PR. For Cal.com, a PR made deletion callbacks `async` inside `forEach`, so their promises were still never awaited; the reviewer dismissed it because the base also discarded those promises. When a PR edits the defective expression itself, the reviewer and validator now report the concrete defect and say that the edited code carries it. Untouched pre-existing code stays out of scope.

## Regression platform with a live model

The [platform](platform/quickstart.md) investigates a PR with three specialist agents, writes a regression test, runs it on the base and PR commits in a network-isolated container, has an independent agent judge intent, and proposes a fix that must pass the frozen test and the existing suite. `scripts/platform-live-eval.py` turns each [multi-file scenario](../examples/scenarios) into a Git mirror with a regression PR and a valid alternative PR, withholds the scenario's contract test from the platform, and uses it afterwards to check every proposed fix.

| Run (gpt-6.1-sol, high) | Regressions reproduced | Fixes passing withheld contract tests | Valid changes flagged |
|---|---:|---:|---:|
| 1 | 3 of 3 | 3 of 3 | 0 of 3 |
| 2 | 3 of 3 | 3 of 3 | 0 of 3 |
| 3 | 3 of 3 | 3 of 3 | 0 of 3 |

Raw records: [`evals/platform/runs/`](../evals/platform/runs). Earlier runs that exposed the problems below are kept in `evals/platform/runs/superseded/`.

Running live for the first time exposed four defects that scripted fixtures had hidden, each now fixed and tested:

- **Citations.** Models quote code correctly but miscount lines; one bad citation failed the whole review. Agents now receive numbered source, grounding tolerates whitespace and multi-line quotes and corrects lines that are off by up to three, and an ungroundable candidate is dropped with a reason instead of failing the review.
- **Retry classification.** A model outage was reported as invalid output and marked non-retryable. Outages are now retryable (503), so Temporal re-runs only the failed specialist; malformed output stays non-retryable (422).
- **Reproduction evidence.** Only `AssertionError` counted, so a regression that surfaced as the code's own `RuntimeError("cursor did not advance")` was marked inconclusive. Exceptions raised inside the reviewed source now count; syntax, import and name errors and exceptions thrown by the test itself still do not.
- **A mislabeled control.** The tenant-cache "valid" change stringified cache keys. The live run proved that tenant `1` and tenant `"1"` then share cached orders while storage keeps them apart: a real cross-tenant leak in the example. The control now uses a per-tenant cache.

## Limitations

- These are well-known open-source PRs, so they may appear in model training data. A fresh, consenting-repository set would be a stronger test.
- Each arm ran once. Independent benchmark analyses report that gaps of a few F1 points between reviewers can be sampling or judge noise.
- The judge is a model. It agrees closely with Martian's published judge but is not a human adjudicator.
- The platform scenarios are authored examples. The platform supports small UTF-8 Python repositories and progresses one candidate per review.
- Runs used a ChatGPT subscription through a local OpenAI-compatible bridge to the Codex CLI. Reported token counts include that client's fixed system prompt, so no per-review dollar cost is claimed.

## Reproduce

```sh
npm ci && npm run build
npm run eval:import -- --limit 50            # freeze the 50 PRs (GitHub read access)
export MODEL_GATEWAY_BASE_URL=... MODEL_GATEWAY_API_KEY=... REVIEW_AGENT_MODEL=...
node scripts/compare-pipeline.mjs --dataset external --cases "$(python3 -c 'import json;print(",".join(json.load(open("evals/martian/split.json"))["heldout"]))')" --limit 50 --arms context-validated --concurrency 10
# Score with any OpenAI-compatible judge endpoint and Martian's offline/ directory:
JUDGE_BASE_URL=... JUDGE_API_KEY=... python3 evals/martian/judge.py --benchmark <martian>/offline \
  --reviews evals/results/comparison-<id> --arm context-validated --name pr-review-agent --tools bugbot,coderabbit --out evals/martian/runs/mine
python3 evals/martian/summarize.py --published evals/martian/runs/published-tools/report.json --ours evals/martian/runs/mine/report.json --subset heldout
```

Platform: start the services from [the quickstart](platform/quickstart.md) with a live provider, then run `uv run --project apps/platform python scripts/platform-live-eval.py --provider <alias>`.
