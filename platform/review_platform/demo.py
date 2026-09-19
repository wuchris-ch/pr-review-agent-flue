"""Provision a deterministic two-commit repository and local demonstration identities."""

import argparse
import json
import os
import secrets
import subprocess
from pathlib import Path

from .agents import FIXED
from .contracts import digest
from .db import Identity, Membership, Repository, Tenant, database


def fixture_repository(path: Path):
    path.mkdir(parents=True, exist_ok=True)

    def git(*args):
        return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()

    if not (path / ".git").exists():
        git("init", "-b", "main")
        git("config", "user.name", "Platform Example")
        git("config", "user.email", "example@example.invalid")
        (path / "README.md").write_text("Apply discounts before sales tax.\n")
        (path / "pricing.py").write_text(FIXED)
        (path / "discounts.py").write_text(
            "def discounted(price, discount):\n    return price * (1 - discount)\n"
        )
        (path / "test_pricing.py").write_text(
            "import unittest\nfrom pricing import total\n\n"
            "class PricingTests(unittest.TestCase):\n"
            "    def test_no_discount(self):\n"
            "        self.assertAlmostEqual(total(100, 0, 0.1), 110)\n"
        )
        git("add", ".")
        git("commit", "-m", "Define discount and tax calculation contract")
        git("checkout", "-b", "example-pr")
        (path / "pricing.py").write_text(
            FIXED.replace(
                "return discounted(price, discount) * (1 + tax)", "return price * (1 + tax)"
            )
        )
        git("add", ".")
        git("commit", "-m", "Introduce example discount regression")
        git("update-ref", "refs/pull/1/head", "HEAD")
    return {
        "base": git("rev-parse", "main"),
        "head": git("rev-parse", "refs/pull/1/head"),
        "pull_request": 1,
    }


def provision(sessions, path: Path, token: str, tenant="demo", user="developer", role="admin"):
    with sessions.begin() as session:
        if not session.get(Tenant, tenant):
            session.add(Tenant(id=tenant, name="Acme Engineering", provider="fixture"))
            session.flush()
        repo_id = f"{tenant}-pricing"
        if not session.get(Repository, repo_id):
            session.add(
                Repository(
                    id=repo_id,
                    tenant_id=tenant,
                    name="acme/pricing",
                    path=str(path.resolve()),
                    suite=["python", "-B", "-m", "unittest", "discover", "-v"],
                    writable_paths=["pricing.py", "discounts.py"],
                )
            )
            session.flush()
        session.merge(Identity(token_hash=digest(token), tenant_id=tenant, user_id=user))
        session.merge(Membership(tenant_id=tenant, repository_id=repo_id, user_id=user, role=role))
    return repo_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", type=Path, default=Path(".demo/repository"))
    parser.add_argument("--output", type=Path, default=Path(".demo/session.json"))
    args = parser.parse_args()
    binding = fixture_repository(args.path)
    _, sessions = database(os.environ["DATABASE_URL"])
    token = secrets.token_urlsafe(32)
    repo_id = provision(sessions, args.path, token)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Token stays in a private local file, outside screenshots, logs and public evidence.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump({"token": token, "repository_id": repo_id, **binding}, output, indent=2)
    print(f"Demo provisioned. Session written to {args.output}. No model calls were made.")


if __name__ == "__main__":
    main()
