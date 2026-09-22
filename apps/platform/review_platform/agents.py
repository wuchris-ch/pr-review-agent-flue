"""Flue subprocess boundary and a visibly separate deterministic demonstration provider."""

import json
import os
import subprocess
from pathlib import Path

from .contracts import Candidate, IntentCheck, Investigation, Reference, Repair, Replacement
from .service import Problem

ROLES = ("cross_file", "security", "api_compatibility")
TASKS = {
    "cross_file": "Find one concrete cross-file regression introduced between base and head. "
    "Return no finding when the evidence is insufficient.",
    "security": "Find one concrete security regression introduced by the change. "
    "Use a harmless executable assertion; do not perform attacks or network requests.",
    "api_compatibility": "Find one unintended break in a documented or tested public API contract. "
    "Distinguish an intentional contract change from a regression.",
    "independent_intent_validator": "Independently decide whether the candidate violates intended "
    "behavior. Cite repository contracts or existing tests. "
    "Reject speculative findings even if their authored test fails.",
    "repair_author": "Return minimal full-file replacements for authorized source paths only. "
    "Preserve general behavior, existing tests and the frozen regression. "
    "Do not special-case the test harness or suppress errors globally.",
}
ROOT = Path(__file__).resolve().parents[3]


class FlueAgents:
    def __init__(self, providers: dict[str, dict[str, str]]):
        self.providers = providers

    def request(self, provider, role, schema, evidence):
        if provider not in self.providers:
            raise Problem(422, "model provider is not provisioned on this worker")
        configuration = self.providers[provider]
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": "/tmp",
            **configuration,
        }
        envelope = {
            "role": role,
            "task": TASKS[role],
            "schema": schema.model_json_schema(),
            "evidence": evidence,
        }
        try:
            result = subprocess.run(
                ["node", str(ROOT / "dist/agents/platform-client.js")],
                input=json.dumps(envelope),
                text=True,
                capture_output=True,
                env=environment,
                cwd=ROOT,
                timeout=210,
                check=True,
            )
            if len(result.stdout) > 128_000:
                raise ValueError("response too large")
            return schema.model_validate_json(result.stdout)
        except (subprocess.SubprocessError, ValueError, OSError):
            raise Problem(422, "specialist returned an invalid or unavailable result") from None

    def investigate(self, provider, role, snapshot):
        return self.request(provider, role, Investigation, snapshot)

    def validate(self, provider, candidate, snapshot, reproduction):
        return self.request(
            provider,
            "independent_intent_validator",
            IntentCheck,
            {
                "candidate": candidate.model_dump(),
                "snapshot": snapshot,
                "reproduction": reproduction,
            },
        )

    def repair(self, provider, candidate, snapshot, allowed):
        return self.request(
            provider,
            "repair_author",
            Repair,
            {
                "candidate": candidate.model_dump(),
                "snapshot": snapshot,
                "authorized_source_paths": allowed,
            },
        )


REGRESSION = """import unittest
from pricing import total

class DiscountContract(unittest.TestCase):
    def test_discount_is_applied_before_tax(self):
        self.assertAlmostEqual(total(100, 0.20, 0.10), 88.0)

if __name__ == "__main__":
    unittest.main()
"""
FIXED = '''from discounts import discounted


def total(price, discount, tax):
    """Apply the discount before calculating sales tax."""
    return discounted(price, discount) * (1 + tax)
'''


class FixtureAgents:
    """Authored answers for examples/platform only. No model inference is claimed."""

    def investigate(self, provider, role, snapshot):
        if role != "cross_file":
            return Investigation(findings=[])
        return Investigation(
            findings=[
                Candidate(
                    title="Discount is dropped before tax calculation",
                    category="cross_file",
                    explanation="The total function must apply the discount before sales tax.",
                    references=[
                        Reference(file="pricing.py", line=6, excerpt="return price * (1 + tax)")
                    ],
                    regression_test=REGRESSION,
                )
            ]
        )

    def validate(self, provider, candidate, snapshot, reproduction):
        return IntentCheck(
            accepted=True,
            reason="The pricing contract explicitly requires discount before tax.",
            references=[
                Reference(file="README.md", line=1, excerpt="Apply discounts before sales tax.")
            ],
        )

    def repair(self, provider, candidate, snapshot, allowed):
        return Repair(
            rationale="Restore the existing discount helper at the calculation boundary.",
            replacements=[Replacement(file="pricing.py", content=FIXED)],
        )


class Agents:
    def __init__(self, providers, allow_fixture=False):
        self.live = FlueAgents(providers)
        self.allow_fixture = allow_fixture

    def for_provider(self, provider):
        if provider == "fixture":
            if not self.allow_fixture:
                raise Problem(422, "fixture provider is disabled")
            return FixtureAgents()
        return self.live
