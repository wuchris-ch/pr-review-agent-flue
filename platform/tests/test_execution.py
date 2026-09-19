import os

import pytest

from review_platform.agents import FIXED, REGRESSION
from review_platform.contracts import Reference, safe_path
from review_platform.execution import DockerExecutor
from review_platform.service import Problem
from review_platform.source import ground


@pytest.mark.parametrize(
    "path", ["../secret", "/etc/passwd", "a/../../b", ".git/config", "a\\b", "a//b", "./a", ""]
)
def test_invalid_paths_are_rejected(path):
    with pytest.raises(ValueError):
        safe_path(path)


def test_source_grounding_rejects_invented_lines():
    with pytest.raises(Problem):
        ground([Reference(file="pricing.py", line=8, excerpt="return 42")], {"pricing.py": "x\n"})


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
