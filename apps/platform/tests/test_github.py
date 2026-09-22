from types import SimpleNamespace

import httpx
import pytest

from review_platform.github import GitHubRevisions
from review_platform.service import Problem
from review_platform.source import GitSource


def test_live_base_branch_overrides_stale_pull_metadata():
    def response(request):
        if "/pulls/" in request.url.path:
            return httpx.Response(
                200,
                json={
                    "state": "open",
                    "head": {"sha": "b" * 40},
                    "base": {"sha": "old", "ref": "main"},
                },
            )
        return httpx.Response(200, json={"object": {"sha": "a" * 40}})

    guard = GitHubRevisions(transport=httpx.MockTransport(response))
    assert guard.snapshot("example/pricing", 1) == ("a" * 40, "b" * 40)


def test_authoritative_remote_change_invalidates_a_stale_local_mirror(env):
    guard = SimpleNamespace(snapshot=lambda *args: ("a" * 40, "b" * 40))
    source = GitSource(guard)
    repository = env["store"].repository(env["review"])
    repository.github_repository = "example/pricing"
    with pytest.raises(Problem, match="stale"):
        source.check(repository, env["review"])


def test_remote_failure_is_not_treated_as_revision_match():
    guard = GitHubRevisions(transport=httpx.MockTransport(lambda request: httpx.Response(503)))
    with pytest.raises(Problem, match="could not be verified"):
        guard.snapshot("example/pricing", 1)


def test_github_outage_is_retryable_and_does_not_supersede_review(env, monkeypatch):
    def unavailable(*args):
        raise Problem(503, "GitHub revision could not be verified")

    monkeypatch.setattr(env["source"], "check", unavailable)
    with pytest.raises(Problem):
        env["pipeline"].snapshot(env["review"].id)
    assert env["store"].get(env["review"].id).state == "queued"
