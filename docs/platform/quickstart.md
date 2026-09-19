# Run the review platform

The deterministic example uses real Git commits, PostgreSQL, Temporal, Docker execution and the React console. Its specialist responses are authored fixtures. No model account, GitHub token or external publication is needed.

Prerequisites: Node.js 22.19+, Python 3.12+, [uv](https://docs.astral.sh/uv/), Git and a running Docker Engine. Commands below run from the repository root on macOS or Linux. Ports 55432, 7233, 8233, 8017 and 5173 must be available.

## Set up

```sh
npm ci
npm run build
npm ci --prefix console
uv sync --project platform --frozen

docker compose -f compose.platform.yml up -d
docker build -t review-platform-runner:local platform/worker_image

# Local demonstration credentials only. Bindings in Compose are loopback-only.
export DATABASE_URL='postgresql+psycopg://review:local-review-password@127.0.0.1:55432/reviews'
uv run --project platform alembic -c platform/alembic.ini upgrade head
uv run --project platform python -m review_platform.demo
```

Wait for `docker compose -f compose.platform.yml ps` to show PostgreSQL as healthy before running the migration. The provisioner creates `.demo/repository` with a correct base commit and a PR commit that drops a discount. It writes a random access token and both commit IDs to `.demo/session.json`, mode 0600. That directory is ignored by Git.

## Start the services

In an API terminal, with `DATABASE_URL` set:

```sh
uv run --project platform uvicorn review_platform.api:from_environment \
  --factory --host 127.0.0.1 --port 8017
```

In a worker terminal, with the same `DATABASE_URL`:

```sh
ALLOW_FIXTURE_PROVIDER=1 uv run --project platform python -m review_platform.worker
```

In a console terminal:

```sh
npm run dev --prefix console
```

Submit the example and wait for its evidence:

```sh
uv run --project platform python scripts/platform-demo.py
```

Open [the console](http://127.0.0.1:5173) and paste the token from the local session file into the password field. Tokens stay in memory. The same file contains the full commit IDs for the **New review** form. Open [Temporal's local UI](http://127.0.0.1:8233) to inspect the workflow history; the API schema is at [OpenAPI](http://127.0.0.1:8017/docs).

Expected result: base regression passes, PR regression fails with an assertion, independent intent validation accepts the finding, and the candidate passes both the frozen regression and existing suite. Review the evidence, patch and logs, then approve or reject. Approval records the user, head commit and evidence digest. It does not push code or post comments.

## Apply an approved fix locally

Use a separate checkout so the demonstration mirror remains unchanged:

```sh
git clone .demo/repository .demo/fix-checkout
# Set REVIEW_PLATFORM_TOKEN from your private session file or secret manager.
uv run --project platform python scripts/apply-approved-fix.py \
  --review REVIEW_ID --repository .demo/fix-checkout
```

The command fetches the current approved bundle from the API, checks its digest, checks the exact local HEAD, requires a clean working tree, runs `git apply --check`, then applies the patch without committing or pushing. Downloaded JSON is useful for inspection; an offline file cannot grant approval to this command. Review and commit the local change through your normal development process.

## Run checks

```sh
npm run verify
python3 scripts/test-regressions.py
uv run --project platform ruff check platform
uv run --project platform pytest platform/tests -q
npm run build --prefix console

# Real Docker execution, Temporal restart/replay and PostgreSQL concurrency:
RUN_DOCKER_TESTS=1 RUN_TEMPORAL_TESTS=1 TEST_POSTGRES_URL="$DATABASE_URL" \
  uv run --project platform pytest platform/tests -q

# The API, worker and console must be running. Each run provisions a fresh tenant.
uv run --project platform python scripts/prepare-console-demo.py
npm exec --prefix console -- playwright install chromium
npm test --prefix console
```

The default Python suite mocks external execution and uses SQLite for quick feedback. The opt-in tests exercise real services. Browser tests capture `docs/platform/console.png` from the running application before approval. No test makes live model calls or writes to GitHub.

## Self-host with your repositories

1. Provision a trusted bare mirror containing `refs/heads/main` and `refs/pull/NUMBER/head`. Refresh it through an operator-controlled fetch process. The API accepts only full commit IDs, never paths, remote URLs or execution commands.
2. Adapt [tenant.example.json](../../examples/platform/tenant.example.json). Keep the manifest private: it contains local filesystem locations. Set each user's token environment variable to at least 32 random characters. Apply it with `uv run --project platform python -m review_platform.provision /path/to/tenant.json`.
3. Set `github_repository` for GitHub repositories. The API and worker recheck the open PR head and actual base branch ref through GitHub before work, approval and export. Give those services a repository-scoped read token if needed. Omit this field only for offline/local repositories whose mirror refs are the authority.
4. Configure worker providers with public aliases and environment-variable indirection. For example:

```sh
export PLATFORM_PROVIDERS='team-model'
export PLATFORM_PROVIDER_ENV='{"team-model":{"MODEL_GATEWAY_API_KEY":"TEAM_MODEL_KEY","MODEL_GATEWAY_BASE_URL":"TEAM_MODEL_URL","REVIEW_AGENT_MODEL":"TEAM_MODEL_NAME"}}'
```

Supply `TEAM_MODEL_KEY`, `TEAM_MODEL_URL` and `TEAM_MODEL_NAME` privately. The console selects only operator-configured aliases. It never receives endpoints or credentials. Disable `ALLOW_FIXTURE_PROVIDER` outside demonstrations. `PLATFORM_PROVIDERS` must match the aliases in the worker configuration.

5. Build a runner image with your offline Python dependencies installed. Set `RUNNER_IMAGE` on the worker. Provision a fixed argument-array suite command and an explicit list of repairable source paths. Do not permit test, CI or dependency-policy files in that list. The initial runner supports Python standard-library tests; other languages require a runner adapter.
6. Use a dedicated Docker daemon/host for the execution controller. The API needs PostgreSQL and repository read access, but no Docker socket. The controller creates job volumes; execution containers receive no socket, credentials or network access. See [the trust boundaries](architecture.md#execution-and-trust-boundaries).
7. For a single-origin deployment, run `npm run build --prefix console`, set `CONSOLE_DIST` to the absolute `console/dist` path, and serve the same FastAPI app behind a TLS reverse proxy. Keep the API and Temporal network private. Replace the local Compose password, configure backups, and use a supported production Temporal service. The included `start-dev` server uses a persistent SQLite history volume; it is a local integration profile, not a production cluster recipe.

The provisioner is an operator tool, not a web administration endpoint. Existing tokens and memberships are retained unless explicitly removed by the operator. There is no SSO, token expiry, user invitation or secret-management UI yet. Review allowances are lifetime tenant reservations, not dollar or token billing.

Stop local infrastructure with `docker compose -f compose.platform.yml down`. Named volumes retain PostgreSQL and Temporal history. Stop the three foreground terminals with Ctrl-C. Do not remove volumes unless you intend to delete the local evidence and history.
