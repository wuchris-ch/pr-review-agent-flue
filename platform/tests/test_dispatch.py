from temporalio.exceptions import WorkflowAlreadyStartedError

from review_platform.db import Review
from review_platform.worker import dispatch_once


class CrashAfterStart:
    def __init__(self):
        self.started = set()
        self.calls = 0

    async def start_workflow(self, run, review_id, *, id, task_queue, id_reuse_policy):
        from temporalio.common import WorkflowIDReusePolicy

        assert id_reuse_policy == WorkflowIDReusePolicy.REJECT_DUPLICATE
        self.calls += 1
        if id in self.started:
            raise WorkflowAlreadyStartedError(id, "ReviewWorkflow")
        self.started.add(id)
        raise ConnectionError("response lost after Temporal accepted start")


async def test_dispatch_reconciles_crash_between_temporal_start_and_database_ack(env):
    client = CrashAfterStart()
    try:
        await dispatch_once(client, env["store"])
    except ConnectionError:
        pass
    with env["sessions"].begin() as session:
        session.get(Review, env["review"].id).state = "investigating"
    await dispatch_once(client, env["store"])
    await dispatch_once(client, env["store"])
    assert len(client.started) == 1 and client.calls == 2
    with env["sessions"]() as session:
        assert session.get(Review, env["review"].id).dispatched
