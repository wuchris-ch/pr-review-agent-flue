# Statement export contract

The nightly statement export passes validated account IDs to `loadBatch`. Supported batches contain up to 10,000 IDs. Each `load` call immediately leases one database connection until its promise settles. The worker's pool has 32 connections and rejects requests when exhausted; the driver does not queue excess leases. The export must complete for every supported batch. This service shares the pool with interactive account reads. Input validation, authorization, and order preservation are handled by the caller and must remain unchanged.
