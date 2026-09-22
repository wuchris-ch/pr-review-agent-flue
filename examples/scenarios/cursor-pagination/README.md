# Stable cursor pagination for order history

The cursor identifies the last returned order. A later page must begin strictly after it. Walking every page must return each order exactly once, in ID order.

`base/` implements the contract. `regression/` introduces a realistic defect. `safe/` makes a similar valid change. The same `contract_test.py` runs unchanged against all three. Context outside each patch is necessary to establish the caller or storage contract.

Run all examples from the repository root:

```sh
python3 scripts/examples/check-scenarios.py
```
