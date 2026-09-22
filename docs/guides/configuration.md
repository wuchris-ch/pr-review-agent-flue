# CLI and repository configuration

`pr-review --help` lists all commands. Run `npm link` from a built checkout to install the command locally, or install a release tarball with `npm install -g ./wuchris-ch-pr-review-agent-flue-0.2.0.tgz`. Export model settings before invoking an installed binary. `npm run cli -- ...` loads the project's local `.env` explicitly.

| Command | Purpose |
| --- | --- |
| `pr-review init` | Create `.pr-review.json` without overwriting existing rules |
| `pr-review doctor` | Check Node and model-setting presence without printing values |
| `pr-review review --base main` | Review tracked local changes relative to the merge base |
| `pr-review pr 123 --repo owner/repo` | Read one GitHub PR and return JSON |
| `pr-review pr 123 --repo owner/repo --publish` | Publish revision-bound review and inline comments |
| `pr-review agent --diff change.diff` | Raw diff to strict JSON, suitable for an evaluator |
| `pr-review feedback --review result.json --finding 1 --decision false-positive --reason 'Caller rejects this input'` | Record a local finding decision |
| `pr-review feedback --summary` | Summarize latest decisions and inspect false-positive reasons |
| `pr-review serve` | Start the self-hosted GitHub App receiver |

Local and raw-diff JSON commands return zero for a completed verdict, including findings. Inspect `blocked`. Invalid inputs and incomplete required stages fail. PR publication uses the configured commit status policy. Legacy `dist/cli.js`, `dist/pr.js`, `dist/review.js` and their Flue aliases remain available. Polling commands have been removed.

## Model settings

The endpoint must support streaming chat completions, JSON object mode, the configured model identifier, and the selected reasoning parameter. Set `REVIEW_REASONING_EFFORT=default` to omit the reasoning parameter for an endpoint that does not support it. Use `pr-review doctor` for missing settings and a small example to verify actual endpoint compatibility.

| Environment variable | Default / purpose |
| --- | --- |
| `MODEL_GATEWAY_API_KEY` | Required API credential |
| `MODEL_GATEWAY_BASE_URL` | Required API prefix; HTTPS or loopback HTTP |
| `REVIEW_AGENT_MODEL` | Required wire model identifier; telemetry uses the alias `reviewer` |
| `REVIEW_REASONING_EFFORT` | `low`; `default` omits the parameter |
| `REVIEW_MAX_OUTPUT_TOKENS` | 32768, including provider reasoning tokens |
| `REVIEW_GATEWAY_TIMEOUT_SECONDS` | 180 seconds shared across HTTP attempts |
| `REVIEW_DEADLINE_SECONDS` | 900 seconds for the full review |
| `REVIEW_CONCURRENCY` | 6 model partitions at once |
| `REVIEW_PARTITION_KIB` | 48 KiB preferred message size |
| `REVIEW_VERIFY_STAGE` | `true`; optional clean-change second opinion |
| `REVIEW_RUN_LOG_DIR` | Opt-in private directory for JSONL run records |

Raw records include source-derived findings. Keep them private. Numeric token usage is recorded only when the endpoint reports it. Dollar cost is unknown without billing evidence, rather than inferred from the transport's zero-valued price placeholders.

## `.pr-review.json`

```json
{
  "version": 1,
  "rules": ["Tenant boundaries must hold on cache hits as well as database reads."],
  "exclude": ["**/generated/**", "**/*.lock"],
  "context": true,
  "validateFindings": true,
  "maxComments": 8,
  "minSeverity": "minor",
  "failOnFindings": false,
  "autoReview": true
}
```

All fields except `version` are optional with the defaults above, except `rules` and `exclude`, which default to empty arrays. Unknown fields fail validation. Files are limited to 16 KiB. Paths use repository-relative `*`, `**`, and `?` globs. The severity floor and comment cap affect inline publication, not the complete JSON result. Excluded files are omitted from review coverage and reported in the rationale.

GitHub configuration comes from the trusted base revision. Local review reads the current checkout's config and retrieves unchanged source from immutable HEAD, excluding changed files to avoid confusing committed content with working-tree edits. A raw diff cannot retrieve a repository on its own.

Feedback stays in `.pr-review/feedback.jsonl`, ignored by Git. It does not silently alter policy. Turn repeated, verified false-positive reasons into narrow rules with examples and a regression test.
