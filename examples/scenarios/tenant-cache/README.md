# Tenant-isolated order caching

Orders belong to a tenant. Cache hits must enforce the same tenant boundary as database reads, including when tenants reuse the same order identifier.

`base/` implements the contract. `regression/` introduces a realistic defect. `safe/` makes a similar valid change. The same `contract_test.py` runs unchanged against all three. Context outside each patch is necessary to establish the caller or storage contract.

Run all examples from the repository root:

```sh
python3 scripts/examples/check-scenarios.py
```
