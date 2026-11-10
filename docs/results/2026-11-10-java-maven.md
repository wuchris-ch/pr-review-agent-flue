# Java (Maven and JUnit) reproduction, November 10, 2026

The review platform ran end to end on a Java Maven project: FastAPI and PostgreSQL took the review, Temporal ran the stages, three specialist agents and an independent validator used gpt-6.1-sol at high reasoning effort through an OpenAI-compatible endpoint, and every test ran in the network-isolated Docker sandbox. The scenario is [retry-backoff](../../examples/scenarios/retry-backoff). Records: `evals/platform/runs/2026-11-10T22-06-49`, `2026-11-10T22-08-14` and `2026-11-10T22-09-49`.

## Scenario

`RetryPolicy.delayFor(attempt)` caps `Backoff.exponential(baseMillis, attempt)` at the maximum delay. The README requires delays that double from the base, never go negative, never exceed the maximum and never decrease, for every attempt number. The regression PR changes `Backoff.exponential` to `return baseMillis << attempt;`. With a 1 ms base, that returns `Long.MIN_VALUE` at attempt 63, and at attempt 64 Java masks the shift distance to zero, so the delay falls back to 1 ms. The repository's own JUnit tests still pass. The valid PR rewrites the helper as a saturating doubling loop.

## Results

| Run | Regression PR | Valid PR | Fix passes withheld `ContractTest.java` |
|---|---|---|---|
| 22:06 UTC | Reproduced, awaiting approval in 1.7 min | No finding, 0.3 min | Yes |
| 22:08 UTC | Reproduced, awaiting approval in 1.3 min | No finding, 0.5 min | Yes |
| 22:09 UTC | Reproduced, awaiting approval in 1.5 min | No finding, 0.7 min | Yes |

In every run, all three specialists (cross-file, security and API compatibility) reported the overflow, and the model wrote a different JUnit class each time.

## First run in detail

Base commit `9f1c894`, PR commit `9312026`. The model wrote this regression test:

```java
package com.acme.retry;

import java.time.Duration;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

public class RetryPolicyLargeAttemptRegressionTest {
    @Test
    public void saturatedDelayRemainsAtMaximumForLargeAttempts() {
        Duration maximum = Duration.ofSeconds(30);
        RetryPolicy policy = new RetryPolicy(Duration.ofMillis(1), maximum);

        Assertions.assertAll(
            () -> Assertions.assertEquals(maximum, policy.delayFor(62)),
            () -> Assertions.assertEquals(maximum, policy.delayFor(63)),
            () -> Assertions.assertEquals(maximum, policy.delayFor(64)),
            () -> Assertions.assertEquals(maximum, policy.delayFor(Integer.MAX_VALUE))
        );
    }
}
```

The controller put the class at `src/test/java/com/acme/retry/RetryPolicyLargeAttemptRegressionTest.java` and ran `mvn test -Dtest=com.acme.retry.RetryPolicyLargeAttemptRegressionTest` offline in the sandbox on each commit. The runner's Surefire summaries:

```text
base (exit 0, passed):
SUREFIRE {"tests": 1, "problems": []}

PR (exit 1, failed):
SUREFIRE {"tests": 1, "problems": [{"test": "com.acme.retry.RetryPolicyLargeAttemptRegressionTest.saturatedDelayRemainsAtMaximumForLargeAttempts",
  "kind": "failure", "type": "org.opentest4j.MultipleFailuresError",
  "message": "Multiple Failures (3 failures)
    org.opentest4j.AssertionFailedError: expected: <PT30S> but was: <PT-2562047788015H-12M-55.808S>
    org.opentest4j.AssertionFailedError: expected: <PT30S> but was: <PT0.001S>
    org.opentest4j.AssertionFailedError: expected: <PT30S> but was: <PT-2562047788015H-12M-55.808S>",
  "frames": ["at org.junit.jupiter.api.AssertAll.assertAll(AssertAll.java:80)", ...]}]}
```

The failure is an assertion, so the platform recorded the regression as reproduced. The independent validator accepted it, citing the README contract, the existing maximum-delay test, `Long.MIN_VALUE` at attempt 63 and the 1 ms delay at attempt 64. The repair agent proposed this patch:

```diff
--- a/src/main/java/com/acme/retry/Backoff.java
+++ b/src/main/java/com/acme/retry/Backoff.java
@@ -4,8 +4,15 @@
 final class Backoff {
     private Backoff() {}
 
-    /** Returns base * 2^attempt. */
+    /** Returns base * 2^attempt, saturating at Long.MAX_VALUE instead of overflowing. */
     static long exponential(long baseMillis, int attempt) {
-        return baseMillis << attempt;
+        if (attempt >= Long.SIZE - 1) {
+            return Long.MAX_VALUE;
+        }
+        long factor = 1L << attempt;
+        if (baseMillis > Long.MAX_VALUE / factor) {
+            return Long.MAX_VALUE;
+        }
+        return baseMillis * factor;
     }
 }
```

With the patch, the frozen regression test, the PR's existing suite (`mvn test`) and the patched suite all passed, so the review waited for a developer's approval. The withheld contract test also passed on the patched files.

## Runs kept as superseded

- **22:00 UTC (first version of the scenario).** The platform flagged the "valid" PR, correctly. That version accepted a base delay under one millisecond, which truncates to 0 ms. The original helper saturated to the maximum at attempt 63, but the doubling loop doubled zero forever: `delayFor(Integer.MAX_VALUE)` returned 0 after 2,147,483,647 iterations. The scenario now rejects bases under one millisecond in every variant.
- **22:00 to 22:03 UTC (three runs).** Same outcomes as the runs above, on a runner build that also counted exception-message lines containing "at " as stack frames. That did not affect these assertion failures, but it could have hidden an exception thrown in the main sources. The runner now keeps only lines that start with `at `, and the runs above use the fixed build.
