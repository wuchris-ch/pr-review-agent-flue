# Capped retry backoff (Java, Maven and JUnit)

Retry delays start at the base delay and double with each attempt, capped at the maximum delay. For every attempt number, a delay is never negative, never exceeds the maximum and never decreases. Delays have millisecond precision, so the base delay must be at least one millisecond.

`base/` implements the contract. `regression/` simplifies the shared `Backoff` helper to `baseMillis << attempt`, which overflows into negative delays and wraps around because Java masks the shift distance to six bits. `safe/` rewrites the helper with a doubling loop that still saturates. Each variant is a Maven project with JUnit 5 tests. The defect is visible only by reading `RetryPolicy` and `Backoff` together.

`ContractTest.java` is withheld from the platform. `scripts/platform-live-eval.py` and the platform's Docker tests run it in the sandbox image against each variant and against every proposed fix.
