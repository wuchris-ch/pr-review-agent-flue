# Self-hosted GitHub App

Use the Action for a repository-local installation. Use this receiver when one operator wants to serve several repositories with installation-scoped credentials and a single webhook endpoint.

Create a GitHub App using the permissions/events in [manifest.json](manifest.json), replace the example URL with your HTTPS endpoint, generate a private key and install the App on selected repositories. The manifest is a configuration template; the project does not register an App or host it for you.

Configure the three model settings plus:

- `GITHUB_APP_ID`: App ID.
- `GITHUB_APP_PRIVATE_KEY_FILE`: private PEM key file readable by the service.
- `GITHUB_WEBHOOK_SECRET`: randomly generated secret of at least 32 characters, matching GitHub.
- `REVIEW_APP_DATABASE`: persistent SQLite file outside the checkout.
- `PORT`: default 8080.
- `REVIEW_APP_HOST`: default 127.0.0.1. Bind behind your HTTPS reverse proxy.

Run `pr-review serve`. Forward `POST /webhooks/github`; `GET /health` checks receiver availability. Do not expose the key file or database through the proxy. Configure one receiver process per database. Installation tokens are short-lived and cached in memory. The durable queue limits pending/running deliveries to 30 and retains recent delivery IDs for deduplication.

GitHub sends work as events. Startup resumes queued/interrupted deliveries. Failed deliveries are marked failed and can be retried through GitHub's delivery redelivery UI. There is no repository polling or periodic retry loop. Set `autoReview: false` in a repository's config to allow only maintainer `/review` requests. Requests are permission-checked before model spending. Set model and review budgets to suit the installation's workload.

The receiver shares the Action's revision checks, base-branch policy, inline comment caps and durable GitHub receipts. For multiple receiver replicas, replace the single-process SQLite queue with a transactional shared queue before scaling out.
