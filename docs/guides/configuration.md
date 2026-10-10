# CLI and repository configuration

`pr-review --help` lists all commands. Run `npm link` from a built checkout to install the command locally, or install a release tarball with `npm install -g ./wuchris-ch-pr-review-agent-flue-0.3.0.tgz`. Export model settings before invoking an installed binary. `npm run cli -- ...` loads the project's local `.env` explicitly.

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
| `REVIEW_CONTEXT_KIB` | 40 KiB of repository context per partition: whole changed files first, then related excerpts. It never displaces diff text |
| `REVIEW_EXPLORE` | `false`; before reviewing, the model searches and reads source at the PR's head revision, and the excerpts it read join the repository context. See [results](../results.md) |
| `REVIEW_EXPLORE_ROUNDS` | 3 exploration round trips (1 to 4), each with at most 8 lookups |
| `REVIEW_EXPLORE_CONTEXT_KIB` | 24 KiB of extra context room per partition for explored excerpts |
| `REVIEW_VERIFY_STAGE` | `true`; optional clean-change second opinion |
| `REVIEW_HUNT_STAGES` | `false`; focused defect-hunting passes. Off by default because they doubled false positives in [benchmarking](../results.md) |
| `REVIEW_HUNT_FOCUS` | `logic,state,contracts`; which hunts run when hunting is on |
| `REVIEW_RUN_LOG_DIR` | Opt-in private directory for JSONL run records |

## Agent reviewer

With a local checkout, a coding agent can do the bug finding. Set `REVIEW_AGENT_CLI=claude` (Claude Code) or `REVIEW_AGENT_CLI=codex` (Codex CLI) and run `pr-review review --base main`. The agent reads the change and the surrounding repository on its own, with read-only tools: it can search and read files and run read-only `git` commands, and it cannot edit files, run project code or use the network. Its findings then go through the same engine as model findings: each one is kept only when it cites a line the change edits, duplicates are merged, and the verdict and GitHub publication rules apply unchanged. The CLI must be installed and signed in. The model passes, exploration and the clean-change second opinion do not run in this mode.

With Claude Opus 5.5, the agent reviewer found 56% of the known issues on 30 held-out benchmark PRs at 49% precision, against 29% at 51% for the model pipeline ([results](../results.md#agent-reviewer-october-9)).

| Environment variable | Default / purpose |
| --- | --- |
| `REVIEW_AGENT_CLI` | Unset; `claude` or `codex` turns on the agent reviewer for local checkouts |
| `REVIEW_AGENT_CLI_MODEL` | The CLI's own default; for example `claude-opus-5-5` or `gpt-6.1-sol` |
| `REVIEW_AGENT_CLI_EFFORT` | `high` |
| `REVIEW_AGENT_CLI_TIMEOUT_SECONDS` | 1200 seconds for one agent review |
| `REVIEW_AGENT_LINE_TOLERANCE` | 0; how many lines a finding may sit from the changed line it is tied to |
| `REVIEW_AGENT_VALIDATE` | `false`; also run evidence validation over the agent's findings. Off because on the development split it removed 8 of 19 real issues along with 19 of 35 false ones and lowered F1 ([results](../results.md#development-decisions-20-prs-48-issues)) |

The GitHub Action and App read pull requests through the API without a checkout, so they keep the model passes. [ReviewBench](../../integrations/reviewbench/README.md) shows the agent reviewer packaged as a container.

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

Use `rules` to describe repository invariants, supported workloads, compatibility promises, and intentional exceptions. See [review priorities](review-priorities.md) for concrete examples and how the system prompt uses them.

GitHub configuration comes from the trusted base revision. Local review reads the current checkout's config and retrieves unchanged source from immutable HEAD, excluding changed files to avoid confusing committed content with working-tree edits. A raw diff cannot retrieve a repository on its own.

Feedback stays in `.pr-review/feedback.jsonl`, ignored by Git. It does not silently alter policy. Turn repeated, verified false-positive reasons into narrow rules with examples and a regression test.
