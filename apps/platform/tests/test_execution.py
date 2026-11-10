import json
import os
from pathlib import Path

import pytest

from review_platform.agents import FIXED, REGRESSION
from review_platform.contracts import Reference, safe_path
from review_platform.execution import (
    DockerExecutor,
    demonstrates_regression,
    junit_test_path,
    surefire_report,
)
from review_platform.service import Problem
from review_platform.source import ground, grounded, numbered

SCENARIO = Path(__file__).resolve().parents[3] / "examples/scenarios/retry-backoff"


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


def surefire_log(*problems, tests=1):
    summary = {"tests": tests, "problems": list(problems)}
    return "[ERROR] Tests run: 1, Failures: 1\nSUREFIRE " + json.dumps(summary)


def junit_problem(kind, exception, frames):
    return {
        "test": "com.acme.retry.RegressionTest.check",
        "kind": kind,
        "type": exception,
        "message": "",
        "frames": frames,
    }


SOURCE_FRAME = "/input/workspace/src/main/java/com/acme/retry/RetryPolicy.java:12"
TEST_FRAME = "at com.acme.retry.RegressionTest.check(RegressionTest.java:9)"


def test_junit_evidence_accepts_assertions_and_source_exceptions():
    assertion = junit_problem("failure", "org.opentest4j.AssertionFailedError", [TEST_FRAME])
    assert demonstrates_regression(surefire_log(assertion))
    thrown = junit_problem("error", "java.lang.IllegalStateException", [SOURCE_FRAME, TEST_FRAME])
    assert demonstrates_regression(surefire_log(thrown))


@pytest.mark.parametrize(
    "log",
    [
        surefire_log(junit_problem("error", "java.lang.NullPointerException", [TEST_FRAME])),
        surefire_log(junit_problem("error", "java.lang.NoSuchMethodError", [SOURCE_FRAME])),
        surefire_log(tests=0),
        # Test output cannot forge evidence: the runner prints its summary last.
        surefire_log(junit_problem("failure", "java.lang.AssertionError", []))
        + "\n"
        + surefire_log(tests=1),
    ],
)
def test_junit_evidence_rejects_test_setup_and_compile_failures(log):
    assert not demonstrates_regression(log)


def test_junit_test_class_is_placed_by_package_and_class_name():
    test = "package com.acme.retry;\n\nimport org.junit.jupiter.api.Test;\n\npublic class Proof {}"
    assert junit_test_path(test) == (
        "src/test/java/com/acme/retry/Proof.java",
        "com.acme.retry.Proof",
    )
    assert junit_test_path("public final class Proof {}") == ("src/test/java/Proof.java", "Proof")
    assert junit_test_path("class Hidden {}") is None


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


def maven_project(variant):
    root = SCENARIO / variant
    return {str(path.relative_to(root)): path.read_text() for path in root.rglob("*.*")}


def junit_class(name, body):
    return f"""package com.acme.retry;

import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import org.junit.jupiter.api.Test;

public class {name} {{
    @Test
    void check() throws Exception {{
        {body}
    }}
}}
"""


@pytest.mark.skipif(os.environ.get("RUN_DOCKER_TESTS") != "1", reason="requires runner image")
def test_real_maven_junit_reproduction_suite_and_boundaries():
    executor = DockerExecutor()
    contract = (SCENARIO / "ContractTest.java").read_text()
    base, regression, safe = (maven_project(v) for v in ("base", "regression", "safe"))
    assert executor.run(base, contract, []).outcome == "passed"
    assert executor.run(safe, contract, []).outcome == "passed"
    broken = executor.run(regression, contract, [])
    assert broken.outcome == "failed" and demonstrates_regression(broken.log)
    assert "negative delay at attempt" in broken.log
    # Message text such as "delay at attempt 57" must not be mistaken for a stack frame.
    [problem] = surefire_report(broken.log)["problems"]
    assert all(frame.startswith("at ") for frame in problem["frames"])
    # The repository's own tests miss the overflow, so the existing suite still passes.
    assert executor.run(regression, None, ["mvn", "test"]).outcome == "passed"

    thrown_in_source = junit_class(
        "SourceThrows", "new RetryPolicy(Duration.ofSeconds(1), Duration.ofMillis(1));"
    )
    result = executor.run(base, thrown_in_source, [])
    assert result.outcome == "failed" and demonstrates_regression(result.log)
    thrown_in_test = junit_class("TestThrows", 'throw new IllegalStateException("test bug");')
    result = executor.run(base, thrown_in_test, [])
    assert result.outcome == "failed" and not demonstrates_regression(result.log)
    does_not_compile = junit_class("Broken", "new RetryPolicy().missing();")
    result = executor.run(base, does_not_compile, [])
    assert result.outcome == "failed" and not demonstrates_regression(result.log)
    isolation = junit_class(
        "Isolation",
        'assertThrows(java.io.IOException.class, () -> new java.net.Socket("1.1.1.1", 443));\n'
        "        assertThrows(java.io.IOException.class, () -> java.nio.file.Files.writeString("
        'java.nio.file.Path.of("/input/workspace/pom.xml"), "x"));',
    )
    assert executor.run(base, isolation, []).outcome == "passed"
