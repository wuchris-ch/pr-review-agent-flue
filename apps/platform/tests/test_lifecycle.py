import json
import subprocess

import pytest
from conftest import headers
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from review_platform.agents import FixtureAgents
from review_platform.contracts import Approval, IntentCheck, Reference, Repair, Replacement, State
from review_platform.db import Artifact, Audit, Tenant
from review_platform.service import Problem


def approve(env, **changes):
    review = env["store"].get(env["review"].id)
    body = dict(head=review.head, evidence_digest=review.evidence_digest, decision="approve")
    body.update(changes)
    return env["client"].post(f"/api/reviews/{review.id}/decision", headers=headers(), json=body)


def test_review_reproduces_validates_and_approves_exact_frozen_evidence(env):
    pipeline, store, review = env["pipeline"], env["store"], env["review"]
    pipeline.run(review.id)
    assert store.get(review.id).state == State.AWAITING_APPROVAL
    calls = env["executor"].calls
    assert len(calls) == 5
    assert calls[0][1] == calls[1][1] == calls[2][1]  # exact test across three revisions
    assert calls[0][0]["pricing.py"] != calls[1][0]["pricing.py"]
    assert calls[1][0]["test_pricing.py"] == calls[2][0]["test_pricing.py"]
    assert approve(env).status_code == 200
    assert approve(env).status_code == 200  # decision retry is idempotent
    response = env["client"].get(f"/api/reviews/{review.id}/approved-fix", headers=headers())
    assert response.status_code == 200
    bundle = response.json()["bundle"]
    assert bundle["passed"] and "discounted(price, discount)" in bundle["patch"]
    with store.sessions() as session:
        actions = session.scalars(select(Audit.action)).all()
    assert actions.count("fix.approved") == 1


def test_approval_requires_matching_commit_evidence_and_role(env):
    env["pipeline"].run(env["review"].id)
    assert approve(env, head="a" * 40).status_code == 409
    assert approve(env, evidence_digest="b" * 64).status_code == 409
    review = env["store"].get(env["review"].id)
    body = Approval(head=review.head, evidence_digest=review.evidence_digest, decision="approve")
    response = env["client"].post(
        f"/api/reviews/{review.id}/decision",
        headers=headers("viewer-token"),
        json=body.model_dump(),
    )
    assert response.status_code == 403
    assert approve(env, decision="reject").status_code == 200
    assert approve(env).status_code == 409
    assert (
        env["client"].get(f"/api/reviews/{review.id}/approved-fix", headers=headers()).status_code
        == 409
    )


@pytest.mark.parametrize("path", ["", "/artifacts/snapshot", "/approved-fix"])
def test_cross_tenant_review_and_artifacts_are_hidden(env, path):
    env["pipeline"].run(env["review"].id)
    response = env["client"].get(
        f"/api/reviews/{env['review'].id}{path}", headers=headers("other-token")
    )
    assert response.status_code == 404
    assert "pricing.py" not in response.text


def test_repository_access_quota_and_submit_idempotency(env):
    client = env["client"]
    route = f"/api/repositories/{env['repo_id']}/reviews"
    assert (
        client.post(route, headers=headers("other-token"), json=env["binding"]).status_code == 404
    )
    assert (
        client.post(route, headers=headers("viewer-token"), json=env["binding"]).status_code == 403
    )
    assert client.get(route).status_code == 401
    first = client.post(route, headers=headers(), json=env["binding"])
    second = client.post(route, headers=headers(), json=env["binding"])
    assert first.json()["id"] == second.json()["id"] == env["review"].id
    with env["sessions"]() as session:
        assert session.get(Tenant, "demo").reviews_used == 1
    assert (
        client.put(
            "/api/settings",
            headers=headers("viewer-token"),
            json={"provider": "fixture", "review_limit": 1},
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/settings",
            headers=headers(),
            json={"provider": "not-configured", "review_limit": 1},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/settings", headers=headers(), json={"provider": "fixture", "review_limit": 1}
        ).status_code
        == 200
    )
    from review_platform.contracts import ReviewRequest

    with pytest.raises(Problem, match="allowance"):
        env["store"].submit(
            env["user"], env["repo_id"], ReviewRequest(base="a" * 40, head="b" * 40, pull_request=2)
        )


def test_database_rejects_cross_tenant_artifact_binding(env):
    with pytest.raises(IntegrityError), env["sessions"].begin() as session:
        session.add(
            Artifact(
                tenant_id="other",
                review_id=env["review"].id,
                name="attack",
                sha256="a" * 64,
                content={},
            )
        )


def test_stale_head_blocks_approval_even_without_new_submission(env):
    env["pipeline"].run(env["review"].id)
    subprocess.run(
        [
            "git",
            "-C",
            str(env["repository"]),
            "update-ref",
            "refs/pull/1/head",
            env["binding"]["base"],
        ],
        check=True,
    )
    assert approve(env).status_code == 409
    assert env["store"].get(env["review"].id).state == State.AWAITING_APPROVAL


def test_superseded_activity_cannot_write_after_new_revision(env):
    from review_platform.contracts import ReviewRequest

    newer = env["store"].submit(
        env["user"],
        env["repo_id"],
        ReviewRequest(base=env["binding"]["base"], head="c" * 40, pull_request=1),
    )
    assert newer.id != env["review"].id
    assert env["store"].get(env["review"].id).state == State.SUPERSEDED
    with pytest.raises(Problem):
        env["store"].record(env["review"].id, "late", {})


def test_resume_adopts_persisted_stage_results_without_reexecution(env):
    pipeline = env["pipeline"]
    pipeline.snapshot(env["review"].id)
    pipeline.investigate(env["review"].id)
    pipeline.reproduce(env["review"].id)
    pipeline.run(env["review"].id)
    pipeline.run(env["review"].id)
    assert len(env["executor"].calls) == 5
    assert env["store"].get(env["review"].id).state == State.AWAITING_APPROVAL


@pytest.mark.parametrize(
    "outcomes",
    [
        ["passed", "passed"],
        ["failed", "failed"],
        ["passed", "infrastructure_error"],
        ["timeout", "failed"],
    ],
)
def test_unconfirmed_reproduction_cannot_generate_a_fix(env, outcomes):
    env["executor"].outcomes = outcomes
    env["pipeline"].run(env["review"].id)
    assert env["store"].get(env["review"].id).state == State.INCONCLUSIVE
    assert env["store"].artifact(env["review"], "proposal") is None


def test_independent_validator_can_veto_finding(env, monkeypatch):
    monkeypatch.setattr(
        FixtureAgents,
        "validate",
        lambda *args: IntentCheck(
            accepted=False,
            reason="Behavior is explicitly intended",
            references=[
                Reference(file="README.md", line=1, excerpt="Apply discounts before sales tax.")
            ],
        ),
    )
    env["pipeline"].run(env["review"].id)
    assert env["store"].get(env["review"].id).state == State.INCONCLUSIVE
    assert len(env["executor"].calls) == 2


def test_fix_cannot_replace_frozen_or_existing_tests(env, monkeypatch):
    monkeypatch.setattr(
        FixtureAgents,
        "repair",
        lambda *args: Repair(
            rationale="skip tests", replacements=[Replacement(file="test_pricing.py", content="\n")]
        ),
    )
    with pytest.raises(Problem, match="unauthorized"):
        env["pipeline"].run(env["review"].id)
    assert env["store"].get(env["review"].id).state != State.AWAITING_APPROVAL
    assert len(env["executor"].calls) == 2


@pytest.mark.parametrize(
    "outcomes",
    [
        ["passed", "failed", "failed", "passed", "passed"],
        ["passed", "failed", "passed", "passed", "failed"],
        ["passed", "failed", "passed", "failed", "passed"],
    ],
)
def test_invalid_fix_or_broken_existing_suite_blocks_approval(env, outcomes):
    env["executor"].outcomes = outcomes
    env["pipeline"].run(env["review"].id)
    assert env["store"].get(env["review"].id).state == State.INCONCLUSIVE
    assert not env["store"].artifact(env["review"], "validated_fix")["passed"]


def test_corrupted_evidence_fails_closed(env):
    env["pipeline"].run(env["review"].id)
    with env["sessions"].begin() as session:
        artifact = session.get(Artifact, ("demo", env["review"].id, "validated_fix"))
        artifact.content = {**artifact.content, "patch": "tampered"}
    assert approve(env).status_code == 409
    response = env["client"].get(
        f"/api/reviews/{env['review'].id}/artifacts/validated_fix", headers=headers()
    )
    assert response.status_code == 409


def test_public_api_does_not_expose_repository_paths_or_token_hashes(env):
    client = env["client"]
    for route in ("/api/session", f"/api/repositories/{env['repo_id']}/reviews"):
        text = json.dumps(client.get(route, headers=headers()).json())
        assert str(env["repository"]) not in text
        assert "token_hash" not in text


@pytest.mark.parametrize(
    "stage,artifact,content,interrupted_state",
    [
        ("reproduce", "reproduction", {"confirmed": False}, State.VALIDATING),
        ("validate", "intent", {"accepted": False}, State.REPAIRING),
    ],
)
def test_negative_result_recovers_crash_before_terminal_state_update(
    env, stage, artifact, content, interrupted_state
):
    # An activity persisted its negative evidence but died before finishing the review.
    env["pipeline"].snapshot(env["review"].id)
    env["store"].record(env["review"].id, artifact, content, interrupted_state)
    assert getattr(env["pipeline"], stage)(env["review"].id) is False
    assert env["store"].get(env["review"].id).state == State.INCONCLUSIVE
    assert len(env["executor"].calls) == 0
