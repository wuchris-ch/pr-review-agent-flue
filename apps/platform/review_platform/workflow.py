"""Replay-safe orchestration. All I/O is contained in activities."""

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy


@workflow.defn
class ReviewWorkflow:
    @workflow.run
    async def run(self, review_id: str):
        options = {
            "start_to_close_timeout": timedelta(minutes=8),
            "retry_policy": RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=2)),
        }
        try:
            await workflow.execute_activity("snapshot", review_id, **options)
            for stage in ("investigate", "reproduce", "validate"):
                if not await workflow.execute_activity(stage, review_id, **options):
                    return
            await workflow.execute_activity("repair", review_id, **options)
        except Exception:
            await workflow.execute_activity("fail", review_id, **options)
            raise
