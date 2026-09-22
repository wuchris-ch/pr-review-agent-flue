"""Read-only authoritative revision checks, kept outside execution and model processes."""

from urllib.parse import quote

import httpx

from .service import Problem


class GitHubRevisions:
    def __init__(self, token: str | None = None, transport=None):
        self.client = httpx.Client(
            base_url="https://api.github.com",
            timeout=15,
            follow_redirects=False,
            transport=transport,
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
        )

    def snapshot(self, repository: str, number: int):
        try:
            response = self.client.get(f"/repos/{repository}/pulls/{number}")
            response.raise_for_status()
            pull = response.json()
            if pull["state"] != "open":
                raise Problem(409, "pull request is no longer open")
            ref = quote(pull["base"]["ref"], safe="")
            response = self.client.get(f"/repos/{repository}/git/ref/heads/{ref}")
            response.raise_for_status()
            return response.json()["object"]["sha"], pull["head"]["sha"]
        except (httpx.HTTPError, KeyError, ValueError):
            raise Problem(503, "GitHub revision could not be verified") from None
