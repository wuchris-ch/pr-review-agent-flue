# GitHub Action packaging

The public entry point is [action.yml](../../action.yml), implemented by `src/bin/action.ts`. [Dockerfile.action](../../Dockerfile.action) stays at the repository root because GitHub's runner uses the Dockerfile's directory as the build context. The independent root `Dockerfile` retains the raw-diff CLI container.

See the [setup guide](../../docs/guides/github-action.md) and [copyable workflow](../../examples/github-actions/review.yml). Verify the Action image with `docker build -f Dockerfile.action -t pr-review-action:test .`.
