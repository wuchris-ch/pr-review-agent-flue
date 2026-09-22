"""Opt-in real service tests. No live model requests or GitHub writes."""

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Replayer, Worker

from review_platform.contracts import ReviewRequest
from review_platform.db import Audit, Review, Tenant, database
from review_platform.demo import fixture_repository, provision
from review_platform.service import Problem, Store
from review_platform.worker import Activities
from review_platform.workflow import ReviewWorkflow


@pytest.mark.skipif(os.environ.get("RUN_TEMPORAL_TESTS") != "1", reason="requires Temporal service")
async def test_temporal_recovers_after_lost_activity_ack_and_worker_restart(env):
    client = await Client.connect(os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"))
    queue = f"test-{uuid4()}"
    committed = asyncio.Event()
    loop = asyncio.get_running_loop()
    pipeline = env["pipeline"]
    activities = Activities(pipeline)

    @activity.defn(name="snapshot")
    def interrupted_snapshot(review_id: str):
        pipeline.snapshot(review_id)
        loop.call_soon_threadsafe(committed.set)
        raise RuntimeError(
            "simulated worker interruption after database commit, before activity ack"
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        async with Worker(
            client,
            task_queue=queue,
            workflows=[ReviewWorkflow],
            activities=[interrupted_snapshot],
            activity_executor=executor,
        ):
            handle = await client.start_workflow(
                ReviewWorkflow.run, env["review"].id, id=queue, task_queue=queue
            )
            await asyncio.wait_for(committed.wait(), timeout=15)
        # New worker instance picks up Temporal retry from persisted history.
        async with Worker(
            client,
            task_queue=queue,
            workflows=[ReviewWorkflow],
            activities=[
                activities.snapshot,
                activities.investigate,
                activities.reproduce,
                activities.validate,
                activities.repair,
                activities.fail,
            ],
            activity_executor=executor,
        ):
            await asyncio.wait_for(handle.result(), timeout=40)
    assert env["store"].get(env["review"].id).state == "awaiting_approval"
    with env["sessions"]() as session:
        assert (
            len(list(session.scalars(select(Audit).where(Audit.action == "evidence.snapshot"))))
            == 1
        )
    assert len(env["executor"].calls) == 5
    await Replayer(workflows=[ReviewWorkflow]).replay_workflow(await handle.fetch_history())


@pytest.mark.skipif(not os.environ.get("TEST_POSTGRES_URL"), reason="requires migrated PostgreSQL")
def test_postgres_serializes_concurrent_quota_reservations(tmp_path):
    engine, sessions = database(os.environ["TEST_POSTGRES_URL"])
    path = tmp_path / "repository"
    binding = fixture_repository(path)
    tenant, token = f"concurrency-{uuid4().hex}", uuid4().hex
    repository = provision(sessions, path, token, tenant=tenant)
    store = Store(sessions)
    principal = store.authenticate(token)
    with sessions.begin() as session:
        session.get(Tenant, tenant).review_limit = 1

    def submit(number):
        try:
            return store.submit(
                principal, repository, ReviewRequest(**{**binding, "pull_request": number})
            ).id
        except Problem as error:
            return error.status

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(submit, range(1, 9)))
    assert results.count(429) == 7
    with sessions() as session:
        assert session.get(Tenant, tenant).reviews_used == 1
        assert len(list(session.scalars(select(Review).where(Review.tenant_id == tenant)))) == 1
    engine.dispose()
