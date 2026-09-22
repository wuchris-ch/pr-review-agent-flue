#!/usr/bin/env python3
"""Prepare a disposable scenario checkout for the real local-review command."""
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "examples/scenarios"
if len(sys.argv) != 4 or sys.argv[1] not in {"tenant-cache", "cursor-pagination", "webhook-idempotency"} or sys.argv[2] not in {"regression", "safe"}:
    raise SystemExit("usage: prepare.py tenant-cache|cursor-pagination|webhook-idempotency regression|safe NEW_DIRECTORY")
scenario = root / sys.argv[1]
destination = Path(sys.argv[3]).resolve()
if destination.exists():
    raise SystemExit("destination must not already exist")
shutil.copytree(scenario / "base", destination)

def git(*args):
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Example Developer", "-c", "user.email=developer@example.com", *args], cwd=destination, check=True, stdout=subprocess.DEVNULL)

git("init", "--initial-branch=main")
git("add", ".")
git("commit", "--no-gpg-sign", "-m", "Establish repository contract")
git("switch", "-c", "example-change")
shutil.copytree(scenario / sys.argv[2], destination, dirs_exist_ok=True)
git("add", ".")
git("commit", "--no-gpg-sign", "-m", "Change application behavior")
print(f"Prepared {destination}. Run pr-review review --base main there.")
