"""Read immutable Git objects. Never checkout or execute repository hooks."""

import io
import os
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

from .contracts import Reference, safe_path
from .service import Problem

MAX_SNAPSHOT_BYTES = 512_000


class GitSource:
    def __init__(self, revisions=None):
        self.revisions = revisions

    def git(self, repository, *args) -> bytes:
        command = [
            "git",
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            repository.path,
            *args,
        ]
        environment = {
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        try:
            with tempfile.TemporaryFile() as output:
                process = subprocess.Popen(
                    command, stdout=output, stderr=subprocess.DEVNULL, env=environment
                )
                started = time.monotonic()
                while process.poll() is None:
                    if (
                        time.monotonic() - started > 15
                        or os.fstat(output.fileno()).st_size > 8_000_000
                    ):
                        process.kill()
                        process.wait()
                        raise Problem(413, "repository command exceeded its time or byte budget")
                    time.sleep(0.01)
                if process.returncode:
                    raise Problem(409, "repository revision is unavailable")
                output.seek(0)
                result = output.read(8_000_001)
                if len(result) > 8_000_000:
                    raise Problem(413, "repository exceeds snapshot budget")
                return result
        except (subprocess.SubprocessError, OSError):
            raise Problem(409, "repository revision is unavailable") from None

    def check(self, repository, review):
        # The provisioner refreshes these refs. No arbitrary client-supplied refs or paths.
        base = self.git(repository, "rev-parse", "refs/heads/main").decode().strip()
        head = (
            self.git(repository, "rev-parse", f"refs/pull/{review.pull_request}/head")
            .decode()
            .strip()
        )
        if repository.github_repository:
            if not self.revisions:
                raise Problem(503, "GitHub revision guard is not configured")
            base, head = self.revisions.snapshot(repository.github_repository, review.pull_request)
        if (base, head) != (review.base, review.head):
            raise Problem(
                409, "review revisions are stale; refresh the mirror and start a new review"
            )

    def snapshot(self, repository, commit: str) -> dict[str, str]:
        files = {}
        size = 0
        archive = self.git(repository, "archive", "--format=tar", commit)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar:
                if member.isdir():
                    continue
                if not member.isfile():
                    raise Problem(422, "source snapshot contains a link or special file")
                # Ignore Git metadata/config and binary assets. Never extract archives on the host.
                if any(p.startswith(".") for p in Path(member.name).parts):
                    continue
                safe_path(member.name)
                size += member.size
                if size > MAX_SNAPSHOT_BYTES or len(files) >= 200:
                    raise Problem(413, "source exceeds the supported small-repository budget")
                try:
                    files[member.name] = tar.extractfile(member).read().decode("utf-8")
                except UnicodeDecodeError:
                    raise Problem(422, "source snapshot must contain UTF-8 text files") from None
        return files


def ground(references: list[Reference], files: dict[str, str]):
    for reference in references:
        lines = files.get(reference.file, "").splitlines()
        if reference.line > len(lines) or reference.excerpt not in lines[reference.line - 1]:
            raise Problem(422, "agent source reference does not match the frozen revision")
