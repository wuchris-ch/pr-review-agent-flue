# Examples

Start with [GitHub Action setup](../docs/guides/github-action.md) to review your own repository, or use the executable scenarios to inspect reviewer behavior locally.

| Example | Defect | Valid control |
| --- | --- | --- |
| [Tenant cache](scenarios/tenant-cache) | A cache hit bypasses tenant isolation | A cache key normalization that retains both identifiers |
| [Cursor pagination](scenarios/cursor-pagination) | Inclusive cursor repeats the previous page boundary | An equivalent strict SQL predicate |
| [Webhook idempotency](scenarios/webhook-idempotency) | A replay credits the account twice | An equivalent duplicate-event check |

Every scenario has `base/`, `regression/`, `safe/`, both diffs, and `contract_test.py`. The checker executes the same frozen contract test against each revision. Base and safe pass; regression must fail an assertion. These are authored development scenarios, not sampled production PRs.

```sh
npm run examples:check
python3 scripts/examples/prepare.py tenant-cache regression /tmp/review-cache-demo
cd /tmp/review-cache-demo
pr-review review --base main
```

The preparer creates a new Git repository at a previously nonexistent destination, commits base on `main`, and commits the selected variant on `example-change`. It does not alter your repositories. Export model settings before calling the installed CLI.

[The platform example](platform/README.md) demonstrates executable reproduction, intent checking, tested repair and approval. The small root-level `.diff` files remain protocol smoke examples for stdin/file integrations.
