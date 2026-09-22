# Settings panel contract

The settings panel passes validated account IDs to `loadBatch`. Its server-side caller enforces at most four IDs, and larger batches are unsupported and rejected before this function. Each `load` call leases one database connection until its promise settles. This isolated worker processes one panel request at a time and has 32 connections available. Input validation, authorization, and order preservation are handled by the caller and must remain unchanged. Parallel reads for these four accounts are an intentional design choice.
