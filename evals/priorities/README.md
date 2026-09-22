# Repository-priority checks

These pairs intentionally hold the code change constant and vary a documented repository contract. Expected labels live in `evals/manifest.json`, separate from the guidance supplied to the reviewer.

| Change | Contract | Expected review |
| --- | --- | --- |
| Replace batches of 20 reads with one `Promise.all` | Up to 10,000 reads; connection pool rejects beyond 32 | Performance defect: connection exhaustion on supported batches |
| Same change | At most four reads; isolated worker with 32 connections | No finding |
| Retry a timed-out inventory submission once | Remote ledger applies every delivery, including repeated IDs | Correctness defect: duplicate adjustment after lost acknowledgement |
| Same change | Remote ledger atomically deduplicates identical event IDs | No finding |

`base.mjs` and `head.mjs` are executable fixtures. `tests/evals/priorities.test.ts` verifies the diff against both files, measures concurrent reads, and simulates a lost acknowledgement under both delivery contracts. The runtime tests do not assert model prose.

Run `node --env-file-if-exists=.env scripts/run-eval.mjs --set priorities` after building. Run `npm run eval:full` to include the existing security and correctness cases as well. The runner passes the diff and contract document, never the expected verdict or expected finding location. Clean cases require zero findings, rather than merely a non-blocking verdict. Inspect private results for semantic correctness as well as the automated file/line/category checks.
