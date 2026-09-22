# Discount regression example

Run `uv run --project apps/platform python -m review_platform.demo` after the migration to create a real two-commit Git repository under `.demo/repository`. See [the complete quickstart](../../docs/platform/quickstart.md).

The base implementation calls `discounted(price, discount)` before applying tax. The PR accidentally taxes the undiscounted price. The existing suite tests zero discount, so it passes on both commits. The new regression checks that a 20% discount and 10% tax turn 100 into 88, instead of 110.

The `fixture` provider supplies authored specialist and validator responses in `apps/platform/review_platform/agents.py`. The platform still snapshots actual Git objects, validates source references, runs five real Docker jobs, freezes the test, stores the evidence, and requires developer approval. This isolates platform behavior from model variability. It is not a model quality benchmark.

`tenant.example.json` is a separate operator-provisioning example for a real repository. Replace its filesystem path and configure the referenced token environment variable privately. It is not read automatically by the demo.
