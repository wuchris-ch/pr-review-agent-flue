package com.acme.retry;

/** Exponential growth shared by the retry policies. */
final class Backoff {
    private Backoff() {}

    /** Returns base * 2^attempt. */
    static long exponential(long baseMillis, int attempt) {
        return baseMillis << attempt;
    }
}
