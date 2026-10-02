# Martian benchmark scoring

Scores reviews on [Martian's offline code review benchmark](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803/offline) and re-scores published tools with the same judge. Results and method: [docs/results.md](../../docs/results.md).

| File | Purpose |
| --- | --- |
| `judge.py` | Batched LLM judge using Martian's matching rule; writes Martian-format evaluations, scores and agreement with Martian's published GPT-5.2 judgments. Any OpenAI-compatible endpoint (`JUDGE_BASE_URL`, `JUDGE_API_KEY`). Results are cached by prompt in `runs/judge-cache.jsonl`. |
| `summarize.py` | Renders the leaderboard table from report files. |
| [`render-benchmark-chart.mjs`](../../scripts/render-benchmark-chart.mjs) | Renders the held-out precision and recall chart, `docs/assets/benchmark.svg`, from the committed reports. Run `node scripts/render-benchmark-chart.mjs` after updating them. |
| `split.json` | Development (20) and held-out (30) PR IDs, fixed before any change: within each repository, IDs sorted by SHA-256, first four to development. |
| `results/` | Committed score reports, judge agreement and per-PR counts (findings, matches, false positives, misses) for each arm. Raw review comments stay private, per the [evaluation guide](../README.md). |
| `runs/` | Ignored working output (full evaluations and judge cache). |

Five published tools are excluded from comparisons because Martian publishes their extracted comments for at most one PR. See `results/judge-agreement.json`.
