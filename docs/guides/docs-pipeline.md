# Docs pipeline

The documentation is published as a site and checked on every pull request. Both steps run in the Docs workflow, `.github/workflows/docs.yml`.

## Documentation site

[The site](https://wuchris-ch.github.io/pr-review-agent-flue/docs/) is built with MkDocs and the Material theme from `docs/` and the README files listed in `mkdocs.yml`. The root README is the home page. `scripts/mkdocs_hooks.py` adds the pages that live outside `docs/` and rewrites relative links: links between published pages stay on the site, and links to source files or folders go to GitHub.

- **Pull request:** the workflow runs `mkdocs build --strict`. A broken link, a missing nav page or a bad anchor fails the build.
- **Merge to main:** the workflow builds the site again, uploads it with `actions/upload-pages-artifact` and deploys it with `actions/deploy-pages`. The project landing page (`docs/index.html`) is published at the Pages root and the documentation under `/docs/`.

Preview the site locally:

```sh
uv run --no-project --with-requirements requirements-docs.txt mkdocs serve
```

## Stale documentation check

On each pull request, the `stale-docs` job asks a model which documentation pages the code change made wrong or incomplete.

1. `src/bin/stale-docs.ts` reads the text diff between the merge base and the pull request head. Binary files are left out.
2. Changed Markdown files count as documentation. If nothing else changed, the check stops without a model call.
3. `src/docs/stale-docs.ts` sends the code diff, the list of pages the pull request already updates, and the current text of every documentation page to the model. Large inputs are truncated or listed by path.
4. The model replies with JSON: each stale page, the reason, and the changed code files behind it. The check keeps a flag only when the page is one it sent and at least one cited file is changed code. Flags for the same page merge.
5. The result goes to the job summary and to one pull request comment, which later runs update. A pull request with no stale pages gets no comment.

The check uses the same model gateway settings as the reviewer: `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_BASE_URL` and `REVIEW_AGENT_MODEL`, stored as repository secrets. Any OpenAI-compatible endpoint works. Without these secrets, for example on a fork pull request, the job writes a skip message and passes. The check is advisory and does not block a merge.

Run it locally against a branch:

```sh
npm run build
npm run docs:stale -- --base origin/main README.md docs/guides/*.md docs/architecture.md
```

Add `--repo owner/name --pr 123` with `GITHUB_TOKEN` set to post or update the pull request comment.
