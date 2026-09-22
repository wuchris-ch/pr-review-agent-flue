import json

import httpx
import pytest
from fastapi.testclient import TestClient

from review_platform.api import create_app
from review_platform.db import Artifact, Repository
from review_platform.publication import GitHubPublisher
from review_platform.service import Problem


class Revisions:
    def __init__(self, binding):
        self.binding = binding

    def check(self, repository, review):
        if (review.base, review.head) != (self.binding["base"], self.binding["head"]):
            raise Problem(409, "stale revisions")


def configured(env, *, lose_response=False):
    env["pipeline"].run(env["review"].id)
    with env["sessions"].begin() as session:
        session.get(Repository, env["repo_id"]).github_repository = "owner/repo"
    reviews, writes = [], []

    def handle(request):
        if request.method == "POST":
            body = json.loads(request.content)
            writes.append(body)
            reviews.append(
                {**body, "id": 42, "state": "COMMENTED", "user": {"login": "reviewer[bot]"}}
            )
            if lose_response:
                raise httpx.ReadTimeout("response lost")
            return httpx.Response(200, json=reviews[-1])
        return httpx.Response(200, json=reviews)

    publisher = GitHubPublisher("test-token", "reviewer[bot]", httpx.MockTransport(handle))
    source = Revisions(dict(env["binding"]))
    client = TestClient(create_app(env["store"], source=source, publisher=publisher))
    return client, source, writes


@pytest.mark.parametrize("lost", [False, True])
def test_publishes_exact_evidence_once_and_reconciles_lost_response(env, lost):
    client, _, writes = configured(env, lose_response=lost)
    path = f"/api/reviews/{env['review'].id}/publish"
    headers = {"Authorization": "Bearer admin-token"}
    first = client.post(path, headers=headers)
    assert first.status_code == 200, first.text
    assert client.post(path, headers=headers).json() == first.json()
    assert len(writes) == 1
    assert writes[0]["commit_id"] == env["review"].head
    assert "Frozen regression test" in writes[0]["body"]
    assert "assertion fails" in writes[0]["body"]
    assert first.json()["url"].endswith("#pullrequestreview-42")


def test_publication_requires_role_and_current_revision(env):
    client, source, writes = configured(env)
    path = f"/api/reviews/{env['review'].id}/publish"
    for token, status in [("viewer-token", 403), ("other-token", 404)]:
        assert client.post(path, headers={"Authorization": f"Bearer {token}"}).status_code == status
    source.binding["head"] = "a" * 40
    assert client.post(path, headers={"Authorization": "Bearer admin-token"}).status_code == 409
    assert not writes


def test_tampered_evidence_cannot_be_published(env):
    client, _, writes = configured(env)
    with env["sessions"].begin() as session:
        artifact = session.get(
            Artifact, (env["review"].tenant_id, env["review"].id, "reproduction")
        )
        artifact.content = {**artifact.content, "test": "print('tampered')"}
    response = client.post(
        f"/api/reviews/{env['review'].id}/publish", headers={"Authorization": "Bearer admin-token"}
    )
    assert response.status_code == 409
    assert not writes
