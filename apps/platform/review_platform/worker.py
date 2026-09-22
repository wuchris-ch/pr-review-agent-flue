import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select
from temporalio import activity
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import ApplicationError, WorkflowAlreadyStartedError
from temporalio.worker import Worker

from .agents import Agents
from .contracts import State
from .db import Review, database
from .execution import DockerExecutor
from .github import GitHubRevisions
from .pipeline import Pipeline
from .service import Problem, Store
from .source import GitSource
from .workflow import ReviewWorkflow

QUEUE = "review-platform"


class Activities:
    def __init__(self, pipeline):
        self.pipeline = pipeline

    def invoke(self, stage, review_id):
        try:
            return getattr(self.pipeline, stage)(review_id)
        except Problem as error:
            raise ApplicationError(error.message, non_retryable=error.status < 500) from None

    @activity.defn
    def snapshot(self, review_id: str):
        return self.invoke("snapshot", review_id)

    @activity.defn
    def investigate(self, review_id: str) -> bool:
        return self.invoke("investigate", review_id)

    @activity.defn
    def reproduce(self, review_id: str) -> bool:
        return self.invoke("reproduce", review_id)

    @activity.defn
    def validate(self, review_id: str) -> bool:
        return self.invoke("validate", review_id)

    @activity.defn
    def repair(self, review_id: str):
        return self.invoke("repair", review_id)

    @activity.defn
    def fail(self, review_id: str):
        self.pipeline.store.finish(
            review_id, State.FAILED, "stage failed; inspect recorded evidence and worker health"
        )


async def dispatch_once(client, store):
    # SQL outbox closes the API-commit / Temporal-start crash gap. Workflow IDs deduplicate starts.
    with store.sessions() as session:
        pending = session.scalars(
            select(Review)
            .where(Review.dispatched.is_(False), Review.state != State.SUPERSEDED)
            .limit(100)
        ).all()
        obsolete = session.scalars(
            select(Review)
            .where(Review.dispatched.is_(True), Review.state == State.SUPERSEDED)
            .limit(100)
        ).all()
    for review in pending:
        try:
            await client.start_workflow(
                ReviewWorkflow.run,
                review.id,
                id=f"review-{review.id}",
                task_queue=QUEUE,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
        except WorkflowAlreadyStartedError:
            pass
        with store.sessions.begin() as session:
            session.get(Review, review.id).dispatched = True
    for review in obsolete:
        try:
            await client.get_workflow_handle(f"review-{review.id}").cancel()
        except Exception:
            # Next poll reconciles failed cancellation delivery.
            continue
        with store.sessions.begin() as session:
            session.get(Review, review.id).dispatched = False


async def serve():
    _, sessions = database(os.environ["DATABASE_URL"])
    store = Store(sessions)
    # Configuration file contains only aliases and environment variable names, never secrets.
    config = json.loads(os.environ.get("PLATFORM_PROVIDER_ENV", "{}"))
    allowed = {
        "MODEL_GATEWAY_API_KEY",
        "MODEL_GATEWAY_BASE_URL",
        "REVIEW_AGENT_MODEL",
        "REVIEW_MAX_OUTPUT_TOKENS",
        "REVIEW_REASONING_EFFORT",
    }
    providers = {
        alias: {key: os.environ[value] for key, value in mapping.items() if key in allowed}
        for alias, mapping in config.items()
    }
    pipeline = Pipeline(
        store,
        GitSource(GitHubRevisions(os.environ.get("GITHUB_TOKEN"))),
        Agents(providers, allow_fixture=os.environ.get("ALLOW_FIXTURE_PROVIDER") == "1"),
        DockerExecutor(os.environ.get("RUNNER_IMAGE", "review-platform-runner:local")),
    )
    activities = Activities(pipeline)
    client = await Client.connect(os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"))
    with ThreadPoolExecutor(max_workers=4) as executor:
        async with Worker(
            client,
            task_queue=QUEUE,
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
            max_concurrent_activities=4,
        ):
            while True:
                try:
                    await dispatch_once(client, store)
                except Exception:
                    print(
                        "dispatch retry pending; check database and Temporal connectivity",
                        flush=True,
                    )
                await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(serve())
