"""Transactional authorization, lifecycle and immutable evidence storage."""

import json
from dataclasses import dataclass

from sqlalchemy import select

from .contracts import TERMINAL, Approval, ReviewRequest, State, digest
from .db import Artifact, Audit, Identity, Membership, Repository, Review, Tenant, now


class Problem(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message
        super().__init__(message)


@dataclass(frozen=True)
class Principal:
    tenant: str
    user: str


RANK = {"viewer": 0, "reviewer": 1, "admin": 2}


def authorize(session, principal: Principal, repository_id: str, role="viewer") -> Repository:
    membership = session.get(Membership, (principal.tenant, repository_id, principal.user))
    if not membership:
        raise Problem(404, "repository not found")
    if RANK[membership.role] < RANK[role]:
        raise Problem(403, f"{role} role required")
    return session.get(Repository, repository_id)


def audit(session, principal, repository_id, action, subject):
    session.add(
        Audit(
            tenant_id=principal.tenant,
            repository_id=repository_id,
            actor=principal.user,
            action=action,
            subject=subject,
        )
    )


def encoded(content: dict) -> str:
    return json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class Store:
    def __init__(self, sessions):
        self.sessions = sessions

    def authenticate(self, token: str) -> Principal:
        with self.sessions() as session:
            identity = session.get(Identity, digest(token))
            if not identity:
                raise Problem(401, "invalid access token")
            return Principal(identity.tenant_id, identity.user_id)

    def submit(self, principal: Principal, repository_id: str, request: ReviewRequest) -> Review:
        with self.sessions.begin() as session:
            authorize(session, principal, repository_id, "reviewer")
            # Tenant lock serializes quota reservations across repositories.
            tenant = session.scalar(
                select(Tenant).where(Tenant.id == principal.tenant).with_for_update()
            )
            session.scalar(
                select(Repository).where(Repository.id == repository_id).with_for_update()
            )
            existing = session.scalar(
                select(Review).where(
                    Review.repository_id == repository_id,
                    Review.pull_request == request.pull_request,
                    Review.base == request.base,
                    Review.head == request.head,
                )
            )
            if existing:
                return existing
            if tenant.reviews_used >= tenant.review_limit:
                raise Problem(429, "tenant review allowance exhausted")
            prior = session.scalars(
                select(Review).where(
                    Review.repository_id == repository_id,
                    Review.pull_request == request.pull_request,
                    Review.state.not_in([s.value for s in TERMINAL]),
                )
            )
            for review in prior:
                review.state, review.updated_at = State.SUPERSEDED, now()
                audit(session, principal, repository_id, "review.superseded", review.id)
            tenant.reviews_used += 1
            review = Review(
                tenant_id=principal.tenant,
                repository_id=repository_id,
                provider=tenant.provider,
                **request.model_dump(),
            )
            session.add(review)
            session.flush()
            audit(session, principal, repository_id, "review.requested", review.id)
            return review

    def get(self, review_id: str, principal: Principal | None = None) -> Review:
        with self.sessions() as session:
            review = session.get(Review, review_id)
            if not review or (principal and review.tenant_id != principal.tenant):
                raise Problem(404, "review not found")
            if principal:
                authorize(session, principal, review.repository_id)
            return review

    def repository(self, review: Review) -> Repository:
        with self.sessions() as session:
            return session.get(Repository, review.repository_id)

    def artifact(self, review: Review, name: str) -> dict | None:
        with self.sessions() as session:
            artifact = session.get(Artifact, (review.tenant_id, review.id, name))
            if artifact and digest(encoded(artifact.content)) != artifact.sha256:
                raise Problem(409, "artifact integrity check failed")
            return artifact.content if artifact else None

    def record(self, review_id: str, name: str, content: dict, state: State | None = None) -> dict:
        with self.sessions.begin() as session:
            review = session.scalar(select(Review).where(Review.id == review_id).with_for_update())
            if not review or review.state in TERMINAL:
                raise Problem(409, "review is no longer active")
            key = (review.tenant_id, review.id, name)
            existing = session.get(Artifact, key)
            if existing:
                return existing.content  # retry adopts the first completed result
            serialized = encoded(content)
            if len(serialized) > 2_000_000:
                raise Problem(413, "artifact exceeds storage budget")
            session.add(
                Artifact(
                    tenant_id=review.tenant_id,
                    review_id=review.id,
                    name=name,
                    content=content,
                    sha256=digest(serialized),
                )
            )
            if state:
                review.state = state
            review.updated_at = now()
            audit(
                session,
                Principal(review.tenant_id, "worker"),
                review.repository_id,
                f"evidence.{name}",
                review.id,
            )
            return content

    def finish(self, review_id: str, state: State, error: str | None = None):
        with self.sessions.begin() as session:
            review = session.scalar(select(Review).where(Review.id == review_id).with_for_update())
            if review.state in TERMINAL or review.state == state:
                return
            if state == State.AWAITING_APPROVAL:
                bundle = session.get(Artifact, (review.tenant_id, review.id, "validated_fix"))
                if not bundle or not bundle.content.get("passed"):
                    raise Problem(409, "no validated fix")
                review.evidence_digest = bundle.sha256
            review.state, review.error, review.updated_at = state, error, now()
            audit(
                session,
                Principal(review.tenant_id, "worker"),
                review.repository_id,
                f"review.{state}",
                review.id,
            )

    def decide(
        self, principal: Principal, review_id: str, approval: Approval, check_revision
    ) -> Review:
        with self.sessions.begin() as session:
            review = session.scalar(select(Review).where(Review.id == review_id).with_for_update())
            if not review or review.tenant_id != principal.tenant:
                raise Problem(404, "review not found")
            repository = authorize(session, principal, review.repository_id, "reviewer")
            if review.head != approval.head or review.evidence_digest != approval.evidence_digest:
                raise Problem(409, "approval does not match the reviewed commit and evidence")
            if review.state in {State.APPROVED, State.REJECTED}:
                expected = State.APPROVED if approval.decision == "approve" else State.REJECTED
                if review.state == expected:
                    return review
                raise Problem(409, "decision is already final")
            if review.state != State.AWAITING_APPROVAL:
                raise Problem(409, "review is not awaiting approval")
            check_revision(repository, review)
            bundle = session.get(Artifact, (review.tenant_id, review.id, "validated_fix"))
            if not bundle or digest(encoded(bundle.content)) != approval.evidence_digest:
                raise Problem(409, "artifact integrity check failed")
            review.state = State.APPROVED if approval.decision == "approve" else State.REJECTED
            review.decision_by, review.updated_at = principal.user, now()
            audit(session, principal, review.repository_id, f"fix.{review.state}", review.id)
            return review
