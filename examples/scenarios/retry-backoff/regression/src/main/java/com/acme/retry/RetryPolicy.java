package com.acme.retry;

import java.time.Duration;

/** Decides how long a worker waits before each retry of a failed delivery. */
public final class RetryPolicy {
    private final long baseMillis;
    private final long maxMillis;

    public RetryPolicy(Duration base, Duration max) {
        if (base.toMillis() < 1 || max.compareTo(base) < 0) {
            throw new IllegalArgumentException("need 1 ms <= base <= max");
        }
        this.baseMillis = base.toMillis();
        this.maxMillis = max.toMillis();
    }

    /** Delay before retry number {@code attempt}, counting from 0. */
    public Duration delayFor(int attempt) {
        if (attempt < 0) {
            throw new IllegalArgumentException("attempt must not be negative");
        }
        return Duration.ofMillis(Math.min(maxMillis, Backoff.exponential(baseMillis, attempt)));
    }
}
