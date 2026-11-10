"""Credential-free execution in disposable, resource-bounded Docker containers."""

import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
from uuid import uuid4

from .contracts import RunResult, safe_path
from .service import Problem

SOURCE_ROOT = "/input/workspace/"
FRAME = re.compile(r'^\s*File "([^"]+)", line \d+', re.MULTILINE)
# These usually mean a broken or mismatched test, not changed behavior.
SETUP_ERRORS = {
    "SyntaxError",
    "IndentationError",
    "ImportError",
    "ModuleNotFoundError",
    "NameError",
}
# Java linkage and class-loading errors, which also point at a broken test or build.
JAVA_SETUP_ERRORS = {
    "ClassNotFoundException",
    "NoClassDefFoundError",
    "NoSuchMethodError",
    "NoSuchFieldError",
    "IncompatibleClassChangeError",
    "ExceptionInInitializerError",
    "UnsupportedClassVersionError",
}
JAVA_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.MULTILINE)
JAVA_CLASS = re.compile(r"^\s*public\s+(?:final\s+)?class\s+(\w+)", re.MULTILINE)


def surefire_report(log: str) -> dict | None:
    """The Surefire summary the runner prints last for a Maven project, if there is one."""
    reports = [line for line in log.splitlines() if line.startswith("SUREFIRE ")]
    if not reports:
        return None
    try:
        return json.loads(reports[-1].removeprefix("SUREFIRE "))
    except ValueError:
        return None


def demonstrates_java_regression(report: dict) -> bool:
    """True when a JUnit test failed an assertion, or the reviewed main sources threw."""
    for problem in report["problems"]:
        if problem["kind"] == "failure":
            return True
        exception = problem["type"].rsplit(".", 1)[-1]
        innermost = problem["frames"][0] if problem["frames"] else ""
        if innermost.startswith(SOURCE_ROOT) and exception not in JAVA_SETUP_ERRORS:
            return True
    return False


def demonstrates_regression(log: str) -> bool:
    """True when a failing test run shows changed behavior of the reviewed code.

    Accepts an assertion failure, or an exception raised inside the reviewed source
    (for example a guard that raises on the regression). Exceptions thrown by the test
    itself, and syntax, import or name errors, stay inconclusive.
    Maven projects are judged from the runner's Surefire summary, Python projects from
    unittest output.
    """
    report = surefire_report(log)
    if report is not None:
        return demonstrates_java_regression(report)
    if "FAILED (" not in log:
        return False
    if "AssertionError" in log:
        return True
    for block in log.split("Traceback (most recent call last):")[1:]:
        frames = FRAME.findall(block)
        exception = next(
            (
                line.split(":", 1)[0].strip().rsplit(".", 1)[-1]
                for line in block.splitlines()
                if line and not line[0].isspace() and not line.startswith(("-", "="))
            ),
            None,
        )
        if frames and frames[-1].startswith(SOURCE_ROOT) and exception not in SETUP_ERRORS:
            return True
    return False


def junit_test_path(test: str) -> tuple[str, str] | None:
    """Where a JUnit test class belongs in a Maven project, and its qualified class name."""
    declared = JAVA_CLASS.search(test)
    if not declared:
        return None
    name = declared.group(1)
    package = JAVA_PACKAGE.search(test)
    if not package:
        return f"src/test/java/{name}.java", name
    folder = package.group(1).replace(".", "/")
    return f"src/test/java/{folder}/{name}.java", f"{package.group(1)}.{name}"


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
        workspace, evidence = dict(files), {}
        # No model-defined shell or runtime selection. Suite is operator provisioned.
        if not test:
            command = suite
        elif "pom.xml" in files:
            # Maven compiles the JUnit regression class together with the project's tests.
            placement = junit_test_path(test)
            if placement is None or placement[0] in files:
                return RunResult(
                    exit_code=2,
                    log="regression test must declare a new public JUnit test class",
                    outcome="failed",
                )
            path, class_name = placement
            workspace[path] = test
            command = ["mvn", "test", f"-Dtest={class_name}"]
        else:
            evidence["evidence/regression.py"] = test
            command = ["python", "-B", "/input/evidence/regression.py"]
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            entries = {f"workspace/{safe_path(k)}": v for k, v in workspace.items()}
            entries["evidence/command.json"] = json.dumps(command)
            entries.update(evidence)
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
