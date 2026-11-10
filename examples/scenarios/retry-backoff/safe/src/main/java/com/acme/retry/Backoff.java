package com.acme.retry;

/** Exponential growth shared by the retry policies. */
final class Backoff {
    private Backoff() {}

    /** Returns base * 2^attempt, saturating at Long.MAX_VALUE instead of overflowing. */
    static long exponential(long baseMillis, int attempt) {
        long delay = baseMillis;
        for (int i = 0; i < attempt && delay < Long.MAX_VALUE; i++) {
            delay = delay > Long.MAX_VALUE / 2 ? Long.MAX_VALUE : delay * 2;
        }
        return delay;
    }
}
