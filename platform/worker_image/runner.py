"""Image-owned watchdog survives loss of the orchestrator process."""

import json
import os
import signal
import subprocess

with open("/input/evidence/command.json") as source:
    command = json.load(source)
process = subprocess.Popen(
    command,
    cwd="/input/workspace",
    start_new_session=True,
    env={
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONPATH": "/input/workspace",
        "PYTHONDONTWRITEBYTECODE": "1",
    },
)
try:
    raise SystemExit(process.wait(timeout=30))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    print("execution deadline exceeded", flush=True)
    raise SystemExit(124)
