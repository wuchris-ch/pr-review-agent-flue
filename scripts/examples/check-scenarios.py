#!/usr/bin/env python3
"""Check realistic service contracts against base, regression and safe revisions."""
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "examples" / "scenarios"
cases = json.loads((root / "manifest.json").read_text())
failed = []
for case in cases:
    directory = root / case["directory"]
    for variant in ("base", case["variant"]):
        result = subprocess.run(
            [sys.executable, str(directory / "contract_test.py")],
            cwd=directory / variant,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                 "PYTHONPATH": str(directory / variant), "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=15,
        )
        expected = variant != "regression"
        correct = (result.returncode == 0) == expected
        if not expected:
            correct = correct and "AssertionError" in result.stderr
        if not correct:
            failed.append(f"{case['id']}/{variant}")
        print(f"{'PASS' if correct else 'FAIL'} {case['id']}/{variant}")
if failed:
    raise SystemExit("Unexpected scenario behavior: " + ", ".join(failed))
