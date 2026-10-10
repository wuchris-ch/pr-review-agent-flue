# ReviewBench

[ReviewBench](https://github.com/review-bench/ReviewBench) runs a reviewer image once per pull request, with the pull request checked out at `/work/repo`, and scores the findings file it writes. This directory packages the agent reviewer for it.

`adapter.mjs` reads the contract's inputs, runs the agent reviewer in the checkout (Claude Code by default, read-only tools), keeps findings that cite a line the change edits, and writes `/work/out/findings.json`. It prints the settings it applied, for example `cli=claude model=claude-opus-5-5 effort=high validate=off`.

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
| Labels | `cli=claude`, `model=claude-opus-5-5`, `effort=high` |

The final run reviews all 219 pull requests three times with your key. Use a dedicated key with a spend cap.

