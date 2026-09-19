# Implementation and verification evidence

Checked locally on September 18, 2026 (America/Vancouver), from the successor repository's `origin/main` baseline `4a88c73`, with the platform changes in `platform-review-lifecycle`. The tests below are local results; the expanded GitHub Actions job has not yet run remotely.

## Capability map

| Capability | Implementation | Executable evidence | Scope |
| --- | --- | --- | --- |
| Investigate, reproduce and propose fixes | `platform/review_platform/pipeline.py`, `agents.py`, `src/agents/platform-agent.ts` | `test_lifecycle.py`, `test_agents.py`, `tests/agents/flue.integration.test.ts` | Three typed specialist roles through Flue; one candidate progresses to repair |
| Independent validation on base and PR | `source.py`, `execution.py`, `pipeline.py`, image-owned `runner.py` | `test_execution.py`, validator veto and negative reproduction tests | Exact Git snapshots; same test bytes; separate validator conversation; Python runner |
| Developer-approved, regression-tested repairs | `service.py`, `api.py`, `scripts/apply-approved-fix.py` | `test_apply.py`, approval/rejection, tamper, stale-head and unauthorized-path tests | Approval binds commit and evidence digest; authenticated local application; no automatic Git push |
| Temporal recovery with PostgreSQL | `workflow.py`, `worker.py`, `db.py`, three Alembic migrations | `test_durable_integration.py`, `test_dispatch.py`, negative-result crash-window tests | Actual Temporal restart/replay and PostgreSQL concurrency exercised; local history uses Temporal's development server |
| Outdated-review cancellation and duplicate GitHub prevention | Platform supersession and dispatch; existing `src/watch/service.ts` and `src/sources/github-api.ts` | Platform stale/late-write tests and `tests/watch/binding.test.ts` | Cancellation fences platform writes; GitHub publication reconciliation is in the existing CLI watcher |
| Console, repository roles and tenant boundaries | `console/src`, `api.py`, `service.py`, composite foreign keys in `db.py` | Three Playwright scenarios; authorization/quota/cross-tenant API tests | Provider aliases, lifetime review allowances and audit trail; operator-provisioned tokens and memberships |

## Verification performed

- **154 TypeScript tests (also passed on Node.js 22.23.2):** existing CLI contracts, reviewer stages, Flue/Pi streaming integration, privacy boundaries and watcher binding/reconciliation, plus the new platform-agent route through Flue using a loopback mock gateway.
- **43 Python tests with integration flags:** API/lifecycle/fix checks, real Docker base-pass/PR-fail execution, read-only source/test mounts, immutable runner image binding, absent credentials and denied network access; real PostgreSQL quota contention; real Temporal lost-ack recovery, worker replacement and history replay.
- **Three browser scenarios:** inspect source evidence/patch/logs, approve and download, update allowance, inspect audit events, enforce viewer controls, check mobile width and prevent an in-flight request from restoring a signed-out session.
- **Real local end-to-end demonstration:** FastAPI and PostgreSQL submission, Temporal dispatch, three fixture specialists, base/PR execution, independent fixture validation, candidate regression and suite execution, approval, and authenticated artifact download. The screenshot in the README is captured from this flow. [The saved result](demo-result.json) records the exact commits, evidence digest and execution outcomes.
- **Patch application:** the actual exported candidate applies cleanly to a separate checkout at the reviewed commit. Tests reject dirty worktrees, the wrong HEAD and altered evidence.
- **Schema:** migrations `0001` through `0003` applied to both the local platform database and a fresh PostgreSQL database. Existing user repositories/databases were not migrated.
- **Static/build checks:** TypeScript compilation, React production build, Biome, Ruff, Prettier, `actionlint`, npm audits and `git diff --check`. Biome retains one pre-existing complexity warning in `scripts/compare-reviewers.mjs`. Python's test client emits upstream deprecation warnings; tests pass.
- **Public change-set scan:** Gitleaks found no secrets in changed public files. A whole-repository scan separately identifies three existing synthetic secret-detector fixtures, which were not introduced by this work.
- **Existing deterministic regression examples:** all eight base/head expectations pass under `scripts/test-regressions.py`.

Routine execution uses authored provider responses or mock integrations. The Flue adapter is exercised through the real runtime and a mock streaming endpoint. Live-model reproduction/repair quality, hosted production operation and live GitHub writes were not evaluated in this change.

## Boundaries and remaining work

The complete local path works for the supplied Python example and the documented small-repository profile: at most 200 visible UTF-8 files and 512 KB per revision, a configured offline suite, and explicit repairable source paths. Arbitrary large or multi-language repositories need additional source selection, dependency-image and runner adapters. Hidden files and symlinks are not part of the current snapshot profile.

All specialist candidates are stored, but only one candidate per review proceeds through reproduction and repair. Independent validation is a separate, source-grounded model decision when a live provider is configured; it is not a formal proof or a measured false-positive rate.

The existing watcher prevents duplicate GitHub comments through revision/author-aware reconciliation. The new console currently stores and exports its richer evidence without posting it to GitHub. A shared platform publication outbox and approval-aware GitHub patch delivery are concrete follow-up integrations.

For a production installation, supply production Temporal infrastructure, TLS, backups and a dedicated execution host. SSO, expiring/rotating access tokens, invitations, automated artifact retention, orphan cleanup and token-cost accounting are not implemented. The Compose profile is intentionally a reproducible local service environment.

## Reproduce the evidence

Follow [quickstart.md](quickstart.md). The regular Python command skips three service-dependent tests; set `RUN_DOCKER_TESTS=1`, `RUN_TEMPORAL_TESTS=1` and `TEST_POSTGRES_URL` to run them. Browser tests require running API, worker and console processes and a fresh fixture from `scripts/prepare-console-demo.py`.
