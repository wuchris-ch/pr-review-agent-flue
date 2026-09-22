# Portable review comparison, September 21, 2026

Six authored development scenarios, one repetition per arm, the same privately configured model and transport settings. Three cases introduce regressions; three preserve the repository contract. Labels and expected locations were not provided to the model.

| Arm | Regression location hits | Clean controls without findings | Completed | Median latency | Model calls |
| --- | --- | --- | --- | --- | --- |
| single-pass | 3/3 | 3/3 | 6/6 | 8.9 s | 6 |
| context-validated | 3/3 | 3/3 | 6/6 | 23.3 s | 12 |

Both arms passed these development cases. This run establishes working model integration and equivalent results on the six cases; it does not establish an accuracy improvement from retrieval or validation. The additional passes increased latency and model calls. Token usage and dollar cost were unavailable and remain unknown.

Reproduce with `npm run eval:compare -- --arms single-pass,context-validated`. Inspect complete local records under `evals/results/`; they are ignored by Git. Use the separate external benchmark and human adjudication for real-PR precision and recall.

Integration verification: 165 TypeScript tests, 47 platform tests including Docker/Temporal/PostgreSQL execution, three Playwright browser scenarios, all 12 scenario contract executions, Action image build, package installation and a live raw-diff review from outside the checkout. Ten external PRs were imported into immutable local snapshots. A one-PR transport smoke comparison completed the context/validation arm; the baseline failed its output contract after correction. That failure remains in the record and is not an accuracy score. External finding adjudication is separate work.
