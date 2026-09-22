# Inventory delivery contract

`submit(id, payload)` sends an inventory adjustment to a remote ledger. The server atomically records the event ID with the adjustment and durably deduplicates it: submitting the same ID and payload again acknowledges the existing event without reapplying it. A timeout with code `ETIMEDOUT` can occur after acceptance and before acknowledgement. Other failures are reported as Error objects with different codes. Retrying an identical event once on timeout is the supported recovery procedure. The event object and payload are immutable for the duration of `deliver`.
