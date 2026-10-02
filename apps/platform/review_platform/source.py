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


# Models quote code reliably but miscount lines. A cited excerpt may start this many
# lines away from its stated line; the stored reference is corrected to the real line.
LINE_WINDOW = 3


def _normalized(text: str) -> str:
    return " ".join(text.split())


def locate(reference: Reference, files: dict[str, str]) -> int | None:
    """Return the 1-based line where the excerpt starts in the frozen file, if found nearby.

    Whitespace is normalized and multi-line excerpts must match consecutive non-blank lines.
    """
    if reference.file not in files:
        return None
    lines = files[reference.file].splitlines()
    wanted = [_normalized(line) for line in reference.excerpt.splitlines() if line.strip()]
    if not wanted:
        return None
    low, high = max(1, reference.line - LINE_WINDOW), min(len(lines), reference.line + LINE_WINDOW)
    for start in sorted(range(low, high + 1), key=lambda n: (abs(n - reference.line), n)):
        following = [_normalized(line) for line in lines[start - 1 :] if line.strip()]
        if not lines[start - 1].strip() or len(following) < len(wanted):
            continue
        if all(part in source for part, source in zip(wanted, following)):
            return start
    return None


def grounded(references: list[Reference], files: dict[str, str]) -> list[Reference] | None:
    """Return references with verified line numbers, or None when any cannot be located."""
    verified = []
    for reference in references:
        line = locate(reference, files)
        if line is None:
            return None
        verified.append(reference.model_copy(update={"line": line}))
    return verified


def ground(references: list[Reference], files: dict[str, str]) -> list[Reference]:
    verified = grounded(references, files)
    if verified is None:
        raise Problem(422, "agent source reference does not match the frozen revision")
    return verified


def numbered(files: dict[str, str]) -> dict[str, str]:
    """Prefix each line with its 1-based number so agents can cite exact locations."""
    return {
        path: "\n".join(f"{n}| {line}" for n, line in enumerate(text.splitlines(), 1))
        for path, text in files.items()
    }
