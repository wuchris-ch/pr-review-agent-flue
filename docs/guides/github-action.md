# GitHub Action

Copy [examples/github-actions/review.yml](../../examples/github-actions/review.yml) into the target repository's `.github/workflows/` directory and merge it into the default branch. Add repository secrets `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_BASE_URL`, and `REVIEW_AGENT_MODEL`. Use the built-in `GITHUB_TOKEN`; the Action requires no personal access token or hosted server.

The full workflow declares contents read, pull requests write, commit statuses write and issues read. Organization settings must permit Actions to create reviews. Pin the Action to a reviewed release commit SHA when managing upgrades centrally. Docker Actions require a Linux runner.

## Triggers and forks

- Same-repository PR events run automatically, except drafts.
- **Actions → PR review → Run workflow** accepts a PR number.
- A `/review` issue comment requests a review. The requester must currently have repository write, maintain or admin permission. The Action verifies that permission through GitHub before model spending.
- Fork PRs use the maintainer comment or manual trigger. The sample skips automatic fork workflows, which do not receive the repository's secrets.

The manual and comment workflows run trusted default-branch workflow code. The Action downloads immutable source as data. Do not add a checkout or build of a contributor's PR to this credential-bearing job. The sample does not require `pull_request_target`.

Use `publish: 'false'` to produce only a job summary. Publication is a COMMENT review, never an automatic approval or a code change. Up to eight inline findings appear by default; the summary contains the complete result. Finding fingerprints suppress identical current bot comments across revisions. Changed wording may produce a new comment, and outdated comments may be reported again.

## Policy and reruns

Commit `.pr-review.json` to the target repository. Configuration and `AGENTS.md` come from the PR's base revision, so a PR cannot relax its own policy. New policy takes effect after merging it into the base branch. Model credentials, endpoints and commands cannot be configured in this file.

Reviews are advisory unless `failOnFindings` is true. That setting makes blocker/major findings fail the commit status and Action run. Branch protection should require the **PR review agent** commit status when using the reviewer as a merge gate. Operational failures fail the Action. A changed revision requires a new event or an explicit rerun; it is never represented as a clean review.

The receipt includes a policy digest and exact base/head/diff binding. A rerun can repair a missing commit status without spending another model call or posting a second review. GitHub does not offer an atomic PR revision check plus review creation: the implementation rechecks before and after posting and always pins the comment to the reviewed commit.
