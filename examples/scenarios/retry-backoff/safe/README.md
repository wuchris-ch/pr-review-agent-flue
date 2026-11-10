# Delivery retries

Retry delays start at the base delay and double with each attempt, capped at the maximum delay. For every attempt number, a delay is never negative, never exceeds the maximum and never decreases. Delays have millisecond precision, so the base delay must be at least one millisecond.

Webhook deliveries use `RetryPolicy` to decide how long to wait before each retry. Workers can retry for days, so attempt numbers can grow large.
