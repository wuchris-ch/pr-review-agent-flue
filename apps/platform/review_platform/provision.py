"""Operator-only provisioning. No repository paths or execution commands enter through the API."""

import argparse
import json
import os
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator

from .contracts import Contract, digest, safe_path
from .db import Identity, Membership, Repository, Tenant, database


class RepositoryConfig(Contract):
    id: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    name: str = Field(min_length=1, max_length=200)
    path: str
    github_repository: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
    )
    suite: list[str] = Field(min_length=1, max_length=20)
    writable_paths: list[str] = Field(min_length=1, max_length=100)

    @field_validator("writable_paths")
    @classmethod
    def paths(cls, values):
        return [safe_path(value) for value in values]


class MemberConfig(Contract):
    user_id: str
    token_env: str
    roles: dict[str, Literal["viewer", "reviewer", "admin"]]


class Provisioning(Contract):
    tenant_id: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    name: str
    provider: str
    review_limit: int = Field(ge=1, le=10000)
    repositories: list[RepositoryConfig]
    members: list[MemberConfig]


def provision(config: Provisioning, sessions):
    with sessions.begin() as session:
        existing = session.get(Tenant, config.tenant_id)
        if not existing:
            session.add(
                Tenant(
                    id=config.tenant_id,
                    name=config.name,
                    provider=config.provider,
                    review_limit=config.review_limit,
                )
            )
            session.flush()
        for repo in config.repositories:
            current = session.get(Repository, repo.id)
            if current and current.tenant_id != config.tenant_id:
                raise ValueError("repository ID belongs to another tenant")
            path = Path(repo.path).resolve(strict=True)
            session.merge(
                Repository(**{**repo.model_dump(), "path": str(path)}, tenant_id=config.tenant_id)
            )
        session.flush()
        for member in config.members:
            token = os.environ[member.token_env]
            if len(token) < 32:
                raise ValueError("access tokens must contain at least 32 random characters")
            existing_identity = session.get(Identity, digest(token))
            if existing_identity and (existing_identity.tenant_id, existing_identity.user_id) != (
                config.tenant_id,
                member.user_id,
            ):
                raise ValueError("token already belongs to another identity")
            session.merge(
                Identity(
                    token_hash=digest(token), tenant_id=config.tenant_id, user_id=member.user_id
                )
            )
            for repository_id, role in member.roles.items():
                repository = session.get(Repository, repository_id)
                if not repository or repository.tenant_id != config.tenant_id:
                    raise ValueError("membership repository is outside tenant")
                session.merge(
                    Membership(
                        tenant_id=config.tenant_id,
                        user_id=member.user_id,
                        repository_id=repository_id,
                        role=role,
                    )
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    _, sessions = database(os.environ["DATABASE_URL"])
    provision(Provisioning.model_validate(json.loads(args.manifest.read_text())), sessions)
    print("Provisioning completed")
