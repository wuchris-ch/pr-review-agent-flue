import pytest
from fastapi.testclient import TestClient

from review_platform.agents import Agents
from review_platform.api import create_app
from review_platform.contracts import ReviewRequest, RunResult
from review_platform.db import Base, database
from review_platform.demo import fixture_repository, provision
from review_platform.pipeline import Pipeline
from review_platform.service import Store
from review_platform.source import GitSource


class RecordedExecutor:
    """Explicit execution outcomes at the sandbox boundary, not a local execution fallback."""

    def __init__(self, outcomes=None):
        self.calls = []
        self.outcomes = list(outcomes or ["passed", "failed", "passed", "passed", "passed"])

    def identity(self):
        return "recorded-executor-v1"

    def run(self, files, test, suite, *, image=None):
        assert image == "recorded-executor-v1"
        self.calls.append((dict(files), test, list(suite)))
        outcome = self.outcomes.pop(0)
        log = "AssertionError: 110 != 88\nFAILED (failures=1)" if outcome == "failed" else "OK"
        return RunResult(exit_code=0 if outcome == "passed" else 1, log=log, outcome=outcome)


@pytest.fixture
def env(tmp_path):
    engine, sessions = database(f"sqlite:///{tmp_path / 'platform.db'}")
    Base.metadata.create_all(engine)
    repository = tmp_path / "repository"
    binding = fixture_repository(repository)
    repo_id = provision(sessions, repository, "admin-token")
    provision(sessions, repository, "viewer-token", user="reader", role="viewer")
    provision(sessions, repository, "other-token", tenant="other")
    store = Store(sessions)
    user = store.authenticate("admin-token")
    review = store.submit(user, repo_id, ReviewRequest(**binding))
    source = GitSource()
    executor = RecordedExecutor()
    pipeline = Pipeline(store, source, Agents({}, allow_fixture=True), executor)
    client = TestClient(create_app(store))
    yield dict(
        store=store,
        user=user,
        review=review,
        repo_id=repo_id,
        sessions=sessions,
        pipeline=pipeline,
        executor=executor,
        source=source,
        client=client,
        repository=repository,
        binding=binding,
    )
    engine.dispose()


def headers(token="admin-token"):
    return {"Authorization": f"Bearer {token}"}
