"""Provision one isolated browser-test tenant, without exposing its access token."""

import json
import os
import secrets
from pathlib import Path
from uuid import uuid4

from review_platform.contracts import ReviewRequest
from review_platform.db import database
from review_platform.demo import fixture_repository, provision
from review_platform.service import Store

root = Path(__file__).resolve().parents[1]
repository = root / ".demo" / "browser-repository"
binding = fixture_repository(repository)
_, sessions = database(os.environ["DATABASE_URL"])
store = Store(sessions)
token = secrets.token_urlsafe(32)
tenant = f"browser-{uuid4().hex[:12]}"
repo_id = provision(sessions, repository, token, tenant=tenant)
review = store.submit(store.authenticate(token), repo_id, ReviewRequest(**binding))
viewer_token = secrets.token_urlsafe(32)
provision(
    sessions, repository, viewer_token, tenant=tenant, user="reader", role="viewer"
)
path = root / ".demo" / "browser-session.json"
with os.fdopen(
    os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w"
) as output:
    json.dump(
        {
            "token": token,
            "viewer_token": viewer_token,
            "review_id": review.id,
            "repository_id": repo_id,
            **binding,
        },
        output,
    )
print(
    "Browser fixture provisioned; session credentials kept in .demo/browser-session.json"
)
