package com.acme.retry;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import org.junit.jupiter.api.Test;

class RetryPolicyTest {
    private final RetryPolicy policy = new RetryPolicy(Duration.ofMillis(100), Duration.ofSeconds(30));

    @Test
    void firstRetriesDouble() {
        assertEquals(Duration.ofMillis(100), policy.delayFor(0));
        assertEquals(Duration.ofMillis(200), policy.delayFor(1));
        assertEquals(Duration.ofMillis(400), policy.delayFor(2));
    }

    @Test
    void laterRetriesUseTheMaximum() {
        assertEquals(Duration.ofSeconds(30), policy.delayFor(20));
    }
}
