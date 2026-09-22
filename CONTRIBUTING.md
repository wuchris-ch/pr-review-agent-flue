# Contributing

The root Node package is the portable review engine. `apps/platform` and `apps/console` are optional services. Start with [architecture](docs/architecture.md) and the README directory map.

```sh
npm ci
npm run verify
npm run examples:check
python3 scripts/test-regressions.py
```

Unit and transport tests use local fixtures and a loopback model server, with no paid model calls. Add a regression test for changes to grounding, publication, retries, policy or permissions. Avoid tests that merely restate implementation. The [evaluation guide](evals/README.md) covers live-model comparisons.

For platform work, follow the [quickstart](docs/platform/quickstart.md). Run Ruff, the Python tests, the Docker/Temporal/PostgreSQL integration tests, console build and Playwright. Keep migrations backward compatible and bind approval/publication to the exact evidence and Git revision.

Keep credentials, private model identifiers, local review content and generated reports out of commits. Public examples use generic endpoint settings. Before release, inspect staged files and package contents, scan history for secrets, run required CI and verify the installed tarball from outside the checkout. `npm pack` produces the CLI artifact; root `action.yml` exposes the reusable Action. Release tags identify the reviewed source used by Actions.
