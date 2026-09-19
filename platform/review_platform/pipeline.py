"""Idempotent stage activities. Temporal owns scheduling; this module owns evidence."""

import difflib
from concurrent.futures import ThreadPoolExecutor

from .agents import ROLES
from .contracts import Candidate, State, digest
from .service import Problem, encoded
from .source import ground


class Pipeline:
    def __init__(self, store, source, agents, executor):
        self.store, self.source, self.agents, self.executor = store, source, agents, executor

    def active(self, review_id):
        review = self.store.get(review_id)
        repository = self.store.repository(review)
        if review.state == State.SUPERSEDED:
            raise Problem(409, "review superseded")
        try:
            self.source.check(repository, review)
        except Problem as error:
            if error.status == 409:
                self.store.finish(review_id, State.SUPERSEDED)
            raise
        return review, repository

    def snapshot(self, review_id):
        review, repository = self.active(review_id)
        if self.store.artifact(review, "snapshot"):
            return
        content = {
            "base": self.source.snapshot(repository, review.base),
            "head": self.source.snapshot(repository, review.head),
            "base_commit": review.base,
            "head_commit": review.head,
            "runner_image": self.executor.identity(),
            "suite": repository.suite,
            "writable_paths": repository.writable_paths,
        }
        self.store.record(review_id, "snapshot", content, State.INVESTIGATING)

    def investigate(self, review_id):
        review, _ = self.active(review_id)
        snapshot = self.store.artifact(review, "snapshot")
        agents = self.agents.for_provider(review.provider)

        def run(role):
            cached = self.store.artifact(review, f"agent_{role}")
            if cached:
                return cached
            result = agents.investigate(review.provider, role, snapshot)
            for candidate in result.findings:
                if candidate.category != role:
                    raise Problem(422, "specialist category mismatch")
                ground(candidate.references, snapshot["head"])
            return self.store.record(review_id, f"agent_{role}", result.model_dump())

        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(run, ROLES))
        # Bounded v1: all specialist results retained; one candidate proceeds per review.
        candidates = [finding for result in results for finding in result["findings"]]
        self.store.record(review_id, "investigation", {"candidates": candidates}, State.REPRODUCING)
        if not candidates:
            self.store.finish(review_id, State.NO_FINDING)
            return False
        return True

    def reproduce(self, review_id):
        review, _ = self.active(review_id)
        cached = self.store.artifact(review, "reproduction")
        if cached:
            if not cached["confirmed"]:
                self.store.finish(review_id, State.INCONCLUSIVE)
            return cached["confirmed"]
        snapshot = self.store.artifact(review, "snapshot")
        candidate = Candidate.model_validate(
            self.store.artifact(review, "investigation")["candidates"][0]
        )
        test = candidate.regression_test
        base = self.executor.run(
            snapshot["base"], test, snapshot["suite"], image=snapshot["runner_image"]
        )
        self.active(review_id)
        head = self.executor.run(
            snapshot["head"], test, snapshot["suite"], image=snapshot["runner_image"]
        )
        # Require a real assertion failure; syntax/import/infrastructure failures are inconclusive.
        confirmed = (
            base.outcome == "passed"
            and head.outcome == "failed"
            and "AssertionError" in head.log
            and "FAILED (" in head.log
        )
        content = {
            "confirmed": confirmed,
            "base": base.model_dump(),
            "head": head.model_dump(),
            "test": test,
            "test_digest": digest(test),
            "base_commit": review.base,
            "head_commit": review.head,
        }
        self.store.record(review_id, "reproduction", content, State.VALIDATING)
        if not confirmed:
            self.store.finish(review_id, State.INCONCLUSIVE)
        return confirmed

    def validate(self, review_id):
        review, _ = self.active(review_id)
        cached = self.store.artifact(review, "intent")
        if cached:
            if not cached["accepted"]:
                self.store.finish(review_id, State.INCONCLUSIVE)
            return cached["accepted"]
        snapshot = self.store.artifact(review, "snapshot")
        candidate = Candidate.model_validate(
            self.store.artifact(review, "investigation")["candidates"][0]
        )
        agents = self.agents.for_provider(review.provider)
        result = agents.validate(
            review.provider, candidate, snapshot, self.store.artifact(review, "reproduction")
        )
        ground(result.references, snapshot["head"])
        self.store.record(review_id, "intent", result.model_dump(), State.REPAIRING)
        if not result.accepted:
            self.store.finish(review_id, State.INCONCLUSIVE)
        return result.accepted

    def repair(self, review_id):
        review, _ = self.active(review_id)
        snapshot = self.store.artifact(review, "snapshot")
        reproduction = self.store.artifact(review, "reproduction")
        if not reproduction["confirmed"] or not self.store.artifact(review, "intent")["accepted"]:
            raise Problem(409, "fix requires independent accepted reproduction")
        cached = self.store.artifact(review, "validated_fix")
        if cached:
            self.store.finish(
                review_id, State.AWAITING_APPROVAL if cached["passed"] else State.INCONCLUSIVE
            )
            return
        candidate = Candidate.model_validate(
            self.store.artifact(review, "investigation")["candidates"][0]
        )
        proposal = self.store.artifact(review, "proposal")
        if not proposal:
            agents = self.agents.for_provider(review.provider)
            repair = agents.repair(review.provider, candidate, snapshot, snapshot["writable_paths"])
            proposal = self.store.record(review_id, "proposal", repair.model_dump())
        files = dict(snapshot["head"])
        seen = set()
        patch = []
        for replacement in proposal["replacements"]:
            path = replacement["file"]
            if path not in snapshot["writable_paths"] or path not in files or path in seen:
                raise Problem(422, "repair changed an unauthorized or duplicate path")
            seen.add(path)
            before, after = files[path], replacement["content"]
            if not after.endswith("\n") or not before.endswith("\n"):
                raise Problem(422, "repair files must end with a newline")
            patch.extend(
                difflib.unified_diff(
                    before.splitlines(True),
                    after.splitlines(True),
                    fromfile=f"a/{path}",
                    tofile=f"b/{path}",
                )
            )
            files[path] = after
        if not patch:
            raise Problem(422, "repair made no change")
        # Author never receives an API for changing the frozen test or repository suite.
        regression = self.executor.run(
            files, reproduction["test"], snapshot["suite"], image=snapshot["runner_image"]
        )
        self.active(review_id)
        baseline_suite = self.executor.run(
            snapshot["head"], None, snapshot["suite"], image=snapshot["runner_image"]
        )
        self.active(review_id)
        suite = self.executor.run(files, None, snapshot["suite"], image=snapshot["runner_image"])
        passed = all(result.outcome == "passed" for result in (regression, baseline_suite, suite))
        bundle = {
            "passed": passed,
            "patch": "".join(patch),
            "head_commit": review.head,
            "base_commit": review.base,
            "test_digest": reproduction["test_digest"],
            "regression": regression.model_dump(),
            "existing_suite": suite.model_dump(),
            "baseline_suite": baseline_suite.model_dump(),
            "candidate_digest": digest(encoded(files)),
            "intent_digest": digest(encoded(self.store.artifact(review, "intent"))),
            "proposal_digest": digest(encoded(proposal)),
            "snapshot_digest": digest(encoded(snapshot)),
        }
        self.active(review_id)
        self.store.record(review_id, "validated_fix", bundle)
        self.store.finish(review_id, State.AWAITING_APPROVAL if passed else State.INCONCLUSIVE)

    def run(self, review_id):
        """Direct deterministic test driver. Production invokes these through Temporal."""
        self.snapshot(review_id)
        if self.investigate(review_id) and self.reproduce(review_id) and self.validate(review_id):
            self.repair(review_id)
