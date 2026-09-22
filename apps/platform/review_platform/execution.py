"""Credential-free execution in disposable, resource-bounded Docker containers."""

import io
import json
import os
import subprocess
import tarfile
import tempfile
import time
from uuid import uuid4

from .contracts import RunResult, safe_path
from .service import Problem


class DockerExecutor:
    def __init__(self, image="review-platform-runner:local", timeout=40):
        self.image, self.timeout = image, timeout

    def identity(self) -> str:
        try:
            result = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", self.image],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            image_id = result.stdout.strip()
            if not image_id.startswith("sha256:") or len(image_id) != 71:
                raise ValueError("invalid runner identity")
            return image_id
        except (subprocess.SubprocessError, OSError, ValueError):
            raise Problem(503, "runner image is unavailable") from None

    def run(
        self, files: dict[str, str], test: str | None, suite: list[str], *, image: str | None = None
    ) -> RunResult:
        image = image or self.image
        name = f"review-exec-{uuid4().hex}"
        volume, staging = f"{name}-input", f"{name}-stage"
        command = ["python", "-B", "/input/evidence/regression.py"] if test else suite
        # No model-defined shell or runtime selection. Suite is operator provisioned.
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            entries = {f"workspace/{safe_path(k)}": v for k, v in files.items()}
            entries["evidence/command.json"] = json.dumps(command)
            if test:
                entries["evidence/regression.py"] = test
            for path, content in entries.items():
                data = content.encode()
                entry = tarfile.TarInfo(path)
                entry.size, entry.mode = len(data), 0o444
                tar.addfile(entry, io.BytesIO(data))
        try:
            subprocess.run(
                ["docker", "volume", "create", "--label", "review-platform.execution=true", volume],
                check=True,
                capture_output=True,
                timeout=15,
            )
            subprocess.run(
                [
                    "docker",
                    "create",
                    "--name",
                    staging,
                    "--label",
                    "review-platform.execution=true",
                    "--network=none",
                    "--mount",
                    f"type=volume,src={volume},dst=/input",
                    image,
                ],
                check=True,
                capture_output=True,
                timeout=15,
            )
            subprocess.run(
                ["docker", "cp", "-", f"{staging}:/input"],
                input=archive.getvalue(),
                check=True,
                capture_output=True,
                timeout=20,
            )
            subprocess.run(
                [
                    "docker",
                    "create",
                    "--name",
                    name,
                    "--label",
                    "review-platform.execution=true",
                    "--network=none",
                    "--read-only",
                    "--log-driver=none",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges",
                    "--pids-limit=64",
                    "--memory=256m",
                    "--memory-swap=256m",
                    "--cpus=1",
                    "--user=65534:65534",
                    "--tmpfs=/tmp:rw,noexec,nosuid,size=32m",
                    "--mount",
                    f"type=volume,src={volume},dst=/input,readonly",
                    image,
                ],
                check=True,
                capture_output=True,
                timeout=20,
            )
            with tempfile.TemporaryFile() as output:
                process = subprocess.Popen(
                    ["docker", "start", "-a", name], stdout=output, stderr=subprocess.STDOUT
                )
                started = time.monotonic()
                outcome = None
                while process.poll() is None:
                    if time.monotonic() - started > self.timeout:
                        outcome = "timeout"
                        break
                    if os.fstat(output.fileno()).st_size > 64_000:
                        outcome = "infrastructure_error"
                        break
                    time.sleep(0.05)
                if outcome:
                    subprocess.run(["docker", "kill", name], capture_output=True, timeout=10)
                    process.wait(timeout=10)
                if os.fstat(output.fileno()).st_size > 64_000:
                    outcome = "infrastructure_error"
                output.seek(0)
                log = output.read(64_000).decode(errors="replace")
                if not outcome:
                    outcome = (
                        "timeout"
                        if process.returncode == 124
                        else "passed"
                        if process.returncode == 0
                        else "failed"
                    )
                return RunResult(
                    exit_code=process.returncode or (124 if outcome == "timeout" else 0),
                    log=log,
                    outcome=outcome,
                )
        except (subprocess.SubprocessError, OSError):
            return RunResult(
                exit_code=125,
                log="execution infrastructure unavailable",
                outcome="infrastructure_error",
            )
        finally:
            for command in (
                ["docker", "rm", "-f", name, staging],
                ["docker", "volume", "rm", volume],
            ):
                try:
                    subprocess.run(command, capture_output=True, timeout=15)
                except (subprocess.SubprocessError, OSError):
                    pass
