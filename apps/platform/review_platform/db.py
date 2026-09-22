from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def uid() -> str:
    return str(uuid4())


def now() -> str:
    return datetime.now(UTC).isoformat()


class Base(DeclarativeBase):
    pass


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]
    provider: Mapped[str] = mapped_column(default="fixture")
    review_limit: Mapped[int] = mapped_column(default=100)
    reviews_used: Mapped[int] = mapped_column(default=0)
    __table_args__ = (CheckConstraint("review_limit > 0 AND reviews_used >= 0"),)


class Identity(Base):
    __tablename__ = "identities"
    token_hash: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str]
    user_id: Mapped[str]
    __table_args__ = (ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),)


class Repository(Base):
    __tablename__ = "repositories"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    tenant_id: Mapped[str]
    name: Mapped[str]
    github_repository: Mapped[str | None]
    path: Mapped[str]  # operator-provisioned mirror, never accepted from review requests
    suite: Mapped[list] = mapped_column(JSON)
    writable_paths: Mapped[list] = mapped_column(JSON)
    __table_args__ = (
        UniqueConstraint("tenant_id", "id"),
        UniqueConstraint("tenant_id", "name"),
        ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
    )


class Membership(Base):
    __tablename__ = "memberships"
    tenant_id: Mapped[str] = mapped_column(String, primary_key=True)
    repository_id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    role: Mapped[str]
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "repository_id"], ["repositories.tenant_id", "repositories.id"]
        ),
        CheckConstraint("role IN ('viewer', 'reviewer', 'admin')"),
    )


class Review(Base):
    __tablename__ = "reviews"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    tenant_id: Mapped[str]
    repository_id: Mapped[str]
    pull_request: Mapped[int]
    base: Mapped[str]
    head: Mapped[str]
    provider: Mapped[str]
    state: Mapped[str] = mapped_column(default="queued")
    created_at: Mapped[str] = mapped_column(default=now)
    updated_at: Mapped[str] = mapped_column(default=now)
    error: Mapped[str | None]
    evidence_digest: Mapped[str | None]
    decision_by: Mapped[str | None]
    dispatched: Mapped[bool] = mapped_column(default=False)
    __table_args__ = (
        UniqueConstraint("tenant_id", "id"),
        UniqueConstraint("repository_id", "pull_request", "base", "head"),
        ForeignKeyConstraint(
            ["tenant_id", "repository_id"], ["repositories.tenant_id", "repositories.id"]
        ),
        Index("ix_reviews_dispatch", "dispatched", "state"),
        CheckConstraint("pull_request > 0"),
        CheckConstraint("length(base) = 40 AND length(head) = 40"),
        CheckConstraint(
            "state IN ('queued','investigating','reproducing','validating',"
            "'repairing','awaiting_approval','approved','rejected','no_finding',"
            "'inconclusive','failed','superseded')"
        ),
    )


class Artifact(Base):
    __tablename__ = "artifacts"
    tenant_id: Mapped[str] = mapped_column(String, primary_key=True)
    review_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, primary_key=True)
    sha256: Mapped[str]
    content: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "review_id"], ["reviews.tenant_id", "reviews.id"]),
    )


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str]
    repository_id: Mapped[str | None]
    actor: Mapped[str]
    action: Mapped[str]
    subject: Mapped[str]
    created_at: Mapped[str] = mapped_column(default=now)
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        Index("ix_audit_repository", "tenant_id", "repository_id", "id"),
    )


def database(url: str):
    engine = create_engine(url, pool_pre_ping=True)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

    return engine, sessionmaker(engine, expire_on_commit=False)
