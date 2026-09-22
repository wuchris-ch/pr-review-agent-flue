"""Explicit, revision-bound publication of reproduced evidence into GitHub."""

import html
import re

import httpx
from sqlalchemy import select

from .contracts import State, digest
from .db import Artifact, Review
from .service import Problem, audit, authorize, encoded


def markdown(value):
    return html.escape(str(value)).replace("@", "@\u200b").replace("`", "\\`")


class GitHubPublisher:
    def __init__(self, token, actor=None, transport=None):
        self.actor = actor
        self.client = httpx.Client(
            base_url="https://api.github.com",
            timeout=20,
            follow_redirects=False,
            transport=transport,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        )

    def request(self, method, path, **kwargs):
        try:
            response = self.client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError):
            raise Problem(
                503, "GitHub publication could not be confirmed; retry to reconcile"
            ) from None

    def publish(self, repository, review, body, marker):
        actor = self.actor or self.request("GET", "/user")["login"]
        path = f"/repos/{repository}/pulls/{review.pull_request}/reviews"

        def receipt():
            for page in range(1, 11):
                reviews = self.request("GET", path, params={"per_page": 100, "page": page})
                for item in reviews:
                    if (
                        item.get("user", {}).get("login") == actor
                        and item.get("commit_id") == review.head
                        and item.get("state") == "COMMENTED"
                        and marker in (item.get("body") or "").splitlines()
                    ):
                        return {"id": item["id"], "head": review.head}
                if len(reviews) < 100:
                    return None
            raise Problem(413, "GitHub review history exceeds publication budget")

        existing = receipt()
        if existing:
            return existing
        try:
            self.request(
                "POST", path, json={"event": "COMMENT", "commit_id": review.head, "body": body}
            )
        except Problem:
            pass  # An ambiguous POST must be reconciled before another write.
        result = receipt()
        if not result:
            raise Problem(503, "GitHub publication could not be confirmed; retry to reconcile")
        return result


def publish_evidence(store, source, publisher, user, review_id):
    if publisher is None:
        raise Problem(503, "GitHub evidence publication is not configured")
    with store.sessions.begin() as session:
        review = session.scalar(select(Review).where(Review.id == review_id).with_for_update())
        if not review or review.tenant_id != user.tenant:
            raise Problem(404, "review not found")
        repository = authorize(session, user, review.repository_id, "reviewer")
        if not repository.github_repository or not re.fullmatch(
            r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository.github_repository
        ):
            raise Problem(422, "repository has no GitHub publication target")
        if review.state not in {State.AWAITING_APPROVAL, State.APPROVED}:
            raise Problem(409, "publication requires reproduced, validated evidence")
        source.check(repository, review)
        key = (review.tenant_id, review.id, "github_publication")
        existing = session.get(Artifact, key)
        if existing:
            return existing.content

        def artifact(name):
            value = session.get(Artifact, (review.tenant_id, review.id, name))
            if not value or digest(encoded(value.content)) != value.sha256:
                raise Problem(409, "evidence integrity check failed")
            return value.content

        reproduction = artifact("reproduction")
        intent = artifact("intent")
        finding = artifact("investigation")["candidates"][0]
        fix = artifact("validated_fix")
        if not reproduction["confirmed"] or not intent["accepted"] or not fix["passed"]:
            raise Problem(409, "publication requires accepted regression evidence")
        if digest(encoded(fix)) != review.evidence_digest:
            raise Problem(409, "fix evidence digest mismatch")
        marker = f"<!-- pr-review-evidence:{review.id}:{review.evidence_digest} -->"
        # The test is an inspectable artifact, never an instruction to execute on GitHub.
        test = reproduction["test"]
        fence = "`" * max(3, 1 + max((len(x) for x in re.findall(r"`+", test)), default=0))
        body = "\n".join(
            [
                "## Reproduced regression",
                "",
                markdown(finding["title"]),
                "",
                markdown(finding["explanation"]),
                "",
                f"Base `{review.base}`: passes. PR `{review.head}`: assertion fails.",
                f"Intent check: {markdown(intent['reason'])}",
                "Proposed repair: frozen regression and existing suite pass.",
                "",
                "<details><summary>Frozen regression test</summary>",
                "",
                f"{fence}python",
                test,
                fence,
                "",
                "</details>",
                "",
                f"Evidence SHA-256: `{review.evidence_digest}`",
                "",
                marker,
            ]
        )
        if len(body.encode()) > 60 * 1024:
            raise Problem(413, "evidence review exceeds GitHub size limit")
        source.check(repository, review)
        receipt = publisher.publish(repository.github_repository, review, body, marker)
        source.check(repository, review)
        content = {
            **receipt,
            "url": f"https://github.com/{repository.github_repository}/pull/"
            f"{review.pull_request}#pullrequestreview-{receipt['id']}",
        }
        session.add(
            Artifact(
                tenant_id=review.tenant_id,
                review_id=review.id,
                name="github_publication",
                content=content,
                sha256=digest(encoded(content)),
            )
        )
        audit(session, user, repository.id, "review.published", review.id)
        return content
