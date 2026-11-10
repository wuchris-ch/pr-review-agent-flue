package com.acme.retry;

/** Exponential growth shared by the retry policies. */
final class Backoff {
    private Backoff() {}

    /** Returns base * 2^attempt, saturating at Long.MAX_VALUE instead of overflowing. */
    static long exponential(long baseMillis, int attempt) {
        if (attempt >= Long.SIZE - 1) {
            return Long.MAX_VALUE;
        }
        long factor = 1L << attempt;
        if (baseMillis > Long.MAX_VALUE / factor) {
            return Long.MAX_VALUE;
        }
        return baseMillis * factor;
    }
}
