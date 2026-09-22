# PR Review Agent

Review pull requests from your terminal, a GitHub Action, or a self-hosted GitHub App. Findings cite exact changed lines, use related repository context, and pass a separate evidence check before publication.

Bring your own streaming OpenAI-compatible model endpoint. Each installation uses its own credentials and repository permissions. The CLI and Action run without a database or hosted service.

[GitHub Action setup](docs/guides/github-action.md) · [CLI and configuration](docs/guides/configuration.md) · [Examples](examples/README.md) · [How it works](docs/architecture.md) · [Evaluation](evals/README.md)

## Start with one PR

Requires Node.js 22.19+, Git, and an authenticated [GitHub CLI](https://cli.github.com/) for GitHub reviews.

```sh
git clone https://github.com/wuchris-ch/pr-review-agent-flue.git
cd pr-review-agent-flue
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

Set `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_BASE_URL`, and `REVIEW_AGENT_MODEL` in `.env`. The URL is the API prefix, such as `https://gateway.example/v1`.

```sh
npm run cli -- doctor
npm run cli -- pr https://github.com/owner/repository/pull/123

# Publish one review with inline findings.
npm run cli -- pr 123 --repo owner/repository --publish
```

For a globally available command, run `npm link`. Then use `pr-review init` in your repository, export the three model settings in your shell, and run `pr-review review --base main`. The CLI reads tracked local changes; GitHub review reads immutable revisions from GitHub.

## Add a GitHub Action

Save the [ready-to-copy workflow](examples/github-actions/review.yml) as `.github/workflows/review.yml` in a repository you want reviewed. Configure its three model secrets. It supports automatic reviews of same-repository PRs, a **Run workflow** button, and a maintainer's `/review` comment, including on fork PRs.

```yaml
- uses: wuchris-ch/pr-review-agent-flue@v0.2.1
  with:
    model-key: ${{ secrets.MODEL_GATEWAY_API_KEY }}
    model-url: ${{ secrets.MODEL_GATEWAY_BASE_URL }}
    model: ${{ secrets.REVIEW_AGENT_MODEL }}
```

The Action fetches the diff and source as data through GitHub's API. It does not check out or run PR code. Reviews are advisory by default. [Setup, permissions, forks and branch protection](docs/guides/github-action.md).

## What the reviewer does

- **Find relevant evidence.** Index the diff, partition large changes, and retrieve bounded source excerpts, callers, tests and contracts from the same head revision.
- **Review what matters here.** Use repository contracts and operational limits to prioritize security, serious correctness and reliability bugs, material performance regressions, and compatibility failures. [Customize review priorities](docs/guides/review-priorities.md).
- **Check concrete defects.** Run deterministic checks, model review, an optional second opinion on small otherwise-clean changes, and a fresh validation pass over actual candidate findings.
- **Control noise.** Require exact source citations, consolidate overlapping findings, cap inline comments, apply a severity floor, and suppress current comments already posted by the same bot.
- **Publish against the reviewed revision.** Bind the result to base, merge base, head and diff digest. Recheck before posting and reconcile saved receipts after a lost response.
- **Measure changes.** Record per-stage attempts, latency, input size and numeric usage when available. Compare the full pipeline to a single model pass on the same cases and model.

Evidence validation is source-based. For executable proof, the optional [review platform](docs/platform/quickstart.md) runs the same frozen regression test on base and PR commits, checks intent, tests a repair and records developer approval. Its console can publish reproduced evidence back to the PR. It currently supports small UTF-8 Python repositories and one candidate per review.

## Find your way around

| Directory | What belongs here |
| --- | --- |
| [`src/core/`](src/core) | Diff parsing, exact evidence anchors, schema, policy and budgets |
| [`src/context/`](src/context) | Bounded retrieval from unchanged repository files |
| [`src/stages/`](src/stages) | Static checks, model passes, finding validation and merging |
| [`src/agents/`](src/agents) | Flue runtime, model transport and isolated child processes |
| [`src/github/`](src/github) | API client, revision binding, inline comments and App webhooks |
| [`src/cli/`](src/cli) | CLI commands; executable entry points are in `src/bin/` |
| [`integrations/`](integrations) | Action container and GitHub App configuration |
| [`apps/`](apps) | Optional FastAPI/Temporal platform and React console |
| [`deploy/`](deploy) | Local platform service definitions |
| [`examples/`](examples) | Copyable workflows and runnable multi-file scenarios |
| [`evals/`](evals) | Labelled regression cases, benchmark instructions and results policy |
| [`tests/`](tests) | Engine, CLI, transport and GitHub contract tests |
| [`scripts/`](scripts) | Evaluation, example verification and platform helper commands |
| [`docs/`](docs) | Setup guides, architecture, evaluation evidence and platform scope |

## Try the scenarios

```sh
# Run the identical contract tests against base, regression and valid alternative changes.
npm run examples:check

# Review a multi-file example with repository context.
python3 scripts/examples/prepare.py tenant-cache regression /tmp/review-cache-demo
cd /tmp/review-cache-demo
pr-review review --base main
```

The scenarios model cross-tenant caching, cursor pagination, and payment webhook retries. Each includes an independently runnable contract test and a valid control change. [Browse the examples](examples/README.md).

## Evaluate and contribute

```sh
npm run verify
npm run examples:check
npm run eval:compare -- --arms single-pass,context-validated
```

Comparison results keep failures, clean controls, finding counts, latency and unknown usage visible. The six scenario cases are development checks. The [external benchmark importer](evals/README.md) freezes public PRs and keeps scoring annotations out of the review inputs. See [contributing](CONTRIBUTING.md) for the platform and browser checks.

The implementation draws on patterns examined in [Mira](https://github.com/miracodeai/mira) and [BerriAI's review agent](https://github.com/BerriAI/oss-pr-review-agent): simple installation, repository context, multiple review passes and evidence-first feedback. These capabilities share this project's strict grounding and revision-binding engine.

Apache-2.0. No background repository polling; reviews start from an event or an explicit command.
