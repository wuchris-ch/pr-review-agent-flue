import os

import pytest

from review_platform.agents import FIXED, REGRESSION
from review_platform.contracts import Reference, safe_path
from review_platform.execution import DockerExecutor, demonstrates_regression
from review_platform.service import Problem
from review_platform.source import ground, grounded, numbered


@pytest.mark.parametrize(
    "path", ["../secret", "/etc/passwd", "a/../../b", ".git/config", "a\\b", "a//b", "./a", ""]
)
def test_invalid_paths_are_rejected(path):
    with pytest.raises(ValueError):
        safe_path(path)


def test_source_grounding_rejects_invented_lines():
    with pytest.raises(Problem):
        ground([Reference(file="pricing.py", line=8, excerpt="return 42")], {"pricing.py": "x\n"})


SOURCE = {"pricing.py": "def total(price, tax):\n\n    rate = 1 + tax\n    return price * rate\n"}


def test_grounding_tolerates_whitespace_and_corrects_nearby_lines():
    exact, shifted = ground(
        [
            Reference(file="pricing.py", line=4, excerpt="return   price * rate"),
            Reference(file="pricing.py", line=2, excerpt="rate = 1 + tax"),
        ],
        SOURCE,
    )
    assert (exact.line, shifted.line) == (4, 3)


def test_grounding_matches_multiline_excerpts_across_blank_lines():
    [reference] = ground(
        [
            Reference(
                file="pricing.py", line=1, excerpt="def total(price, tax):\n    rate = 1 + tax"
            )
        ],
        SOURCE,
    )
    assert reference.line == 1


@pytest.mark.parametrize(
    "reference",
    [
        Reference(file="pricing.py", line=4, excerpt="return price * 2"),
        Reference(file="other.py", line=1, excerpt="def total"),
        Reference(file="pricing.py", line=40, excerpt="return price * rate"),
    ],
)
def test_grounding_rejects_unsupported_or_distant_references(reference):
    assert grounded([reference], SOURCE) is None


def test_numbered_view_prefixes_one_based_lines():
    assert numbered({"a.py": "x\ny\n"}) == {"a.py": "1| x\n2| y"}


def traceback_log(frames, exception):
    lines = ["E", "=" * 70, "ERROR: test_contract", "-" * 70, "Traceback (most recent call last):"]
    for path in frames:
        lines += [f'  File "{path}", line 3, in f', "    call()"]
    return "\n".join([*lines, exception, "", "-" * 70, "Ran 1 test", "", "FAILED (errors=1)"])


def test_regression_evidence_accepts_assertions_and_source_exceptions():
    assert demonstrates_regression("AssertionError: 110 != 88\nFAILED (failures=1)")
    raised_in_source = traceback_log(
        ["/input/evidence/regression.py", "/input/workspace/pagination.py"],
        "RuntimeError: cursor did not advance",
    )
    assert demonstrates_regression(raised_in_source)


@pytest.mark.parametrize(
    "log",
    [
        traceback_log(["/input/evidence/regression.py"], "KeyError: 'total'"),
        traceback_log(
            ["/input/evidence/regression.py", "/input/workspace/orders.py"],
            "NameError: name 'cache' is not defined",
        ),
        traceback_log(
            ["/input/evidence/regression.py"], "ModuleNotFoundError: No module named 'x'"
        ),
        "AssertionError: shown without a failing run",
    ],
)
def test_regression_evidence_rejects_test_and_setup_failures(log):
    assert not demonstrates_regression(log)


@pytest.mark.skipif(os.environ.get("RUN_DOCKER_TESTS") != "1", reason="requires runner image")
def test_real_docker_reproduction_and_credential_network_filesystem_boundaries():
    executor = DockerExecutor()
    frozen_image = executor.identity()
    files = {"pricing.py": FIXED, "discounts.py": "def discounted(p, d): return p * (1-d)\n"}
    assert executor.run(files, REGRESSION, []).outcome == "passed"
    files["pricing.py"] = FIXED.replace("discounted(price, discount)", "price")
    broken = executor.run(files, REGRESSION, [])
    assert broken.outcome == "failed" and "AssertionError" in broken.log
    isolation = """import os, socket, unittest
class Isolation(unittest.TestCase):
    def test_boundaries(self):
        keys = ["GITHUB_TOKEN", "MODEL_GATEWAY_API_KEY", "DATABASE_URL"]
        self.assertFalse(any(k in os.environ for k in keys))
        with self.assertRaises(OSError): open("/input/workspace/pricing.py", "w")
        with self.assertRaises(OSError): open("/input/evidence/regression.py", "w")
        with self.assertRaises(OSError): socket.create_connection(("1.1.1.1", 443), timeout=1)
unittest.main()
"""
    assert executor.run(files, isolation, []).outcome == "passed"
    executor.image = "not-available:fixture"
    assert executor.run(files, isolation, [], image=frozen_image).outcome == "passed"
