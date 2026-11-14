# ReviewBench

[ReviewBench](https://github.com/review-bench/ReviewBench) runs a reviewer image once per pull request, with the pull request checked out at `/work/repo`, and scores the findings file it writes. This directory packages the agent reviewer for it.

`adapter.mjs` reads the contract's inputs, runs the agent reviewer in the checkout (Claude Code by default, read-only tools), merges the findings of its passes and writes `/work/out/findings.json`. It prints the settings it applied, for example `cli=claude model=claude-opus-5-5 effort=high runs=1 breadth_runs=1`.

The engine cannot index every diff: it refuses one over 1 MiB, one with a binary file and one with a file too large for a model message. That is 29 of the 219 benchmark pull requests. The agent reads the checkout itself, so the adapter still reviews those and keeps the agent's own locations.

[`evals/reviewbench`](../../evals/reviewbench/README.md) scores a configuration offline before a submission, with the benchmark's matcher and scorer.

## Build and try

```sh
# From the repository root
docker build --platform linux/amd64 -f integrations/reviewbench/Dockerfile -t pr-review-reviewbench:dev .

# From a clone of review-bench/ReviewBench, with ANTHROPIC_API_KEY set in your shell
scripts/try-agent.sh pr-review-reviewbench:dev --pr 0 -e ANTHROPIC_API_KEY
```

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `RB_CONFIG_CLI` | `claude` | `claude` (needs `ANTHROPIC_API_KEY`) or `codex` (needs `OPENAI_API_KEY`) |
| `RB_CONFIG_MODEL` | `claude-opus-5-5` | Model the agent uses |
| `RB_CONFIG_EFFORT` | `high` | Reasoning effort |
| `RB_CONFIG_RUNS` | 1 | Passes with the plain review request (1 to 5) |
| `RB_CONFIG_BREADTH_RUNS` | 0 | Extra passes with the broad review request (0 to 3) |
| `RB_CONFIG_BREADTH_MODEL` | `RB_CONFIG_MODEL` | Model for the broad passes, for example `claude-sonnet-5-5` |
| `RB_CONFIG_GROUNDING` | `off` | `off` keeps each finding where the agent put it; ReviewBench matches findings by file. `exact` keeps only findings on a line the change edits, as the GitHub publisher does |
| `RB_CONFIG_VALIDATE` | `off` | Evidence validation over agent findings; needs `MODEL_GATEWAY_*` settings |
| `RB_CONFIG_TIMEOUT_SECONDS` | 780 | Agent time budget, under ReviewBench's 15-minute limit |

## Registering

Registration happens on [review-bench.ai](https://review-bench.ai) with a GitHub sign-in. The name `pr-review-agent` is already taken by another reviewer, so register under a different one. The values to enter:

| Field | Value |
| --- | --- |
| Image | `ghcr.io/<owner>/<image>@sha256:...` from `docker push` |
| Model API URL | `https://api.anthropic.com` |
| Secret names | `ANTHROPIC_API_KEY` |
| Egress | `api.anthropic.com` |
| Labels | `cli=claude`, `model=claude-opus-5-5`, `effort=high`, and the pass counts when they differ from the defaults |

The final run reviews all 219 pull requests three times with your key. Use a dedicated key with a spend cap. At the API-equivalent cost of the [offline run over all 219 pull requests](../../docs/results.md#all-219-pull-requests), 657 reviews cost about $270 with the default settings and about $700 with `RB_CONFIG_BREADTH_RUNS=1`. With `RB_CONFIG_BREADTH_RUNS=2` and `RB_CONFIG_BREADTH_MODEL=claude-sonnet-5-5` the estimate from the test set is $540.

