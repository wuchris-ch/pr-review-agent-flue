# Helper scripts

| Task | Entry point |
| --- | --- |
| Verify all executable scenario contracts | `examples/check-scenarios.py` |
| Create an isolated local-review example checkout | `examples/prepare.py` |
| Compare pipeline components with one fixed model | `compare-pipeline.mjs` |
| Freeze external PRs with separate scoring labels | `import-external-benchmark.mjs` |
| Compare two reviewer checkouts | `compare-reviewers.mjs` |
| Run the original labelled diff evaluation | `run-eval.mjs` |
| Verify original regression fixtures | `test-regressions.py` |
| Submit a platform demonstration | `platform-demo.py` |
| Prepare isolated browser-test data | `prepare-console-demo.py` |
| Apply an approved platform repair locally | `apply-approved-fix.py` |

Run these from the repository root. Raw-diff evaluator entry points remain stable for external integrations.
