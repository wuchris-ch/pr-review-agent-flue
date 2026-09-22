# Payment webhook idempotency

The payment provider retries events until acknowledged. Replaying an event must acknowledge it without crediting the account again. New event IDs with equal amounts remain distinct payments.

`base/` implements the contract. `regression/` introduces a realistic defect. `safe/` makes a similar valid change. The same `contract_test.py` runs unchanged against all three. Context outside each patch is necessary to establish the caller or storage contract.

Run all examples from the repository root:

```sh
python3 scripts/examples/check-scenarios.py
```
