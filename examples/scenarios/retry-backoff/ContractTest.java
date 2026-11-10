package com.acme.retry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import org.junit.jupiter.api.Test;

/** Withheld from the platform. Checks the delivery retry contract for every variant. */
public class ContractTest {
    private static final Duration MAX = Duration.ofSeconds(30);

    @Test
    void delaysDoubleFromTheBaseAndStayCappedForEveryAttempt() {
        RetryPolicy policy = new RetryPolicy(Duration.ofMillis(100), MAX);
        assertEquals(Duration.ofMillis(800), policy.delayFor(3));
        Duration previous = Duration.ZERO;
        for (int attempt = 0; attempt <= 200; attempt++) {
            Duration delay = policy.delayFor(attempt);
            assertFalse(delay.isNegative(), "negative delay at attempt " + attempt);
            assertTrue(delay.compareTo(MAX) <= 0, "delay above maximum at attempt " + attempt);
            assertTrue(delay.compareTo(previous) >= 0, "delay decreased at attempt " + attempt);
            previous = delay;
        }
        assertEquals(MAX, policy.delayFor(Integer.MAX_VALUE));
    }

    @Test
    void baseDelaysUnderOneMillisecondAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> new RetryPolicy(Duration.ofNanos(1), MAX));
    }
}
