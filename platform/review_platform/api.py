import os
from typing import Annotated

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .contracts import Approval, ReviewRequest, SettingsUpdate, State
from .db import Artifact, Audit, Membership, Repository, Review, Tenant, database
from .github import GitHubRevisions
from .service import Principal, Problem, Store, audit, authorize
from .source import GitSource


def review_json(review):
    return {
        key: getattr(review, key)
        for key in (
            "id",
            "repository_id",
            "pull_request",
            "base",
            "head",
            "provider",
            "state",
            "created_at",
            "updated_at",
            "error",
            "evidence_digest",
            "decision_by",
        )
    }


def create_app(store: Store, source=None, providers=("fixture",)) -> FastAPI:
    source = source or GitSource()
    app = FastAPI(title="PR Review Platform", version="0.1.0")

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, error: Problem):
        return JSONResponse({"detail": error.message}, status_code=error.status)

    def identity(authorization: Annotated[str | None, Header()] = None):
        if not authorization or not authorization.startswith("Bearer "):
            raise Problem(401, "bearer token required")
        return store.authenticate(authorization[7:])

    User = Annotated[Principal, Depends(identity)]

    @app.get("/health")
    def health():
        with store.sessions() as session:
            session.execute(select(Tenant.id).limit(1))
        return {"status": "ok"}

    @app.get("/api/session")
    def session_info(user: User):
        with store.sessions() as session:
            tenant = session.get(Tenant, user.tenant)
            memberships = session.scalars(
                select(Membership).where(
                    Membership.tenant_id == user.tenant, Membership.user_id == user.user
                )
            ).all()
            return {
                "user": user.user,
                "tenant": tenant.name,
                "provider": tenant.provider,
                "review_limit": tenant.review_limit,
                "reviews_used": tenant.reviews_used,
                "available_providers": providers,
                "repositories": [
                    {
                        "id": m.repository_id,
                        "role": m.role,
                        "name": session.get(Repository, m.repository_id).name,
                    }
                    for m in memberships
                ],
            }

    @app.get("/api/repositories/{repository_id}/reviews")
    def reviews(repository_id: str, user: User):
        with store.sessions() as session:
            authorize(session, user, repository_id)
            return [
                review_json(r)
                for r in session.scalars(
                    select(Review)
                    .where(Review.tenant_id == user.tenant, Review.repository_id == repository_id)
                    .order_by(Review.created_at.desc())
                    .limit(100)
                )
            ]

    @app.post("/api/repositories/{repository_id}/reviews", status_code=202)
    def submit(repository_id: str, request: ReviewRequest, user: User):
        with store.sessions() as session:
            repository = authorize(session, user, repository_id, "reviewer")
            source.check(repository, request)
        return review_json(store.submit(user, repository_id, request))

    @app.get("/api/reviews/{review_id}")
    def detail(review_id: str, user: User):
        review = store.get(review_id, user)
        with store.sessions() as session:
            artifacts = session.scalars(
                select(Artifact).where(
                    Artifact.tenant_id == user.tenant, Artifact.review_id == review_id
                )
            )
            return {
                **review_json(review),
                "artifacts": [{"name": a.name, "sha256": a.sha256} for a in artifacts],
            }

    @app.get("/api/reviews/{review_id}/artifacts/{name}")
    def artifact(review_id: str, name: str, user: User):
        review = store.get(review_id, user)
        result = store.artifact(review, name)
        if result is None:
            raise Problem(404, "artifact not found")
        return result

    @app.post("/api/reviews/{review_id}/decision")
    def decide(review_id: str, approval: Approval, user: User):
        return review_json(store.decide(user, review_id, approval, source.check))

    @app.get("/api/reviews/{review_id}/approved-fix")
    def approved_fix(review_id: str, user: User):
        review = store.get(review_id, user)
        if review.state != State.APPROVED:
            raise Problem(409, "fix requires developer approval")
        source.check(store.repository(review), review)
        bundle = store.artifact(review, "validated_fix")
        return {
            "review_id": review.id,
            "head": review.head,
            "evidence_digest": review.evidence_digest,
            "bundle": bundle,
        }

    @app.put("/api/settings")
    def settings(update: SettingsUpdate, user: User):
        with store.sessions.begin() as session:
            memberships = session.scalars(
                select(Membership).where(
                    Membership.tenant_id == user.tenant, Membership.user_id == user.user
                )
            ).all()
            repositories = session.scalars(
                select(Repository).where(Repository.tenant_id == user.tenant)
            ).all()
            admin_ids = {m.repository_id for m in memberships if m.role == "admin"}
            if not repositories or any(repo.id not in admin_ids for repo in repositories):
                raise Problem(403, "administrator access to all tenant repositories required")
            if update.provider not in providers:
                raise Problem(422, "provider is not configured")
            tenant = session.scalar(
                select(Tenant).where(Tenant.id == user.tenant).with_for_update()
            )
            tenant.provider, tenant.review_limit = update.provider, update.review_limit
            audit(session, user, None, "settings.updated", user.tenant)
        return {"status": "updated"}

    @app.get("/api/repositories/{repository_id}/audit")
    def audit_log(repository_id: str, user: User):
        with store.sessions() as session:
            authorize(session, user, repository_id)
            return [
                {
                    "actor": a.actor,
                    "action": a.action,
                    "subject": a.subject,
                    "created_at": a.created_at,
                }
                for a in session.scalars(
                    select(Audit)
                    .where(Audit.tenant_id == user.tenant, Audit.repository_id == repository_id)
                    .order_by(Audit.id.desc())
                    .limit(100)
                )
            ]

    console_dist = os.environ.get("CONSOLE_DIST")
    if console_dist:
        from fastapi.staticfiles import StaticFiles

        app.mount("/", StaticFiles(directory=console_dist, html=True), name="console")
    return app


def from_environment():
    _, sessions = database(os.environ["DATABASE_URL"])
    providers = tuple(os.environ.get("PLATFORM_PROVIDERS", "fixture").split(","))
    return create_app(
        Store(sessions),
        GitSource(GitHubRevisions(os.environ.get("GITHUB_TOKEN"))),
        providers=providers,
    )
