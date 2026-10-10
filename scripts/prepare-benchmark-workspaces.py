#!/usr/bin/env python3
r"""Build one Git workspace per benchmark PR for the agent reviewer.

Each workspace is a small repository with two branches: `main` holds the PR's base tree and
`pr` holds its head tree. The head tree comes from the bare repositories that
fetch-benchmark-sources.py fills; the base tree is the head with the imported change.diff
reversed. The agent reviews `git diff main...pr` and can read and search the whole tree.

    python3 scripts/fetch-benchmark-sources.py --into ~/.cache/pr-review-benchmark-sources
    python3 scripts/prepare-benchmark-workspaces.py \
        --sources ~/.cache/pr-review-benchmark-sources --into ~/.cache/pr-review-benchmark-workspaces
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "evals" / "external" / "manifest.json"
GIT = ["git", "-c", "user.name=benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false"]


def run(cmd: list[str], cwd: Path) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def build(case: str, sources: Path, workspace: Path) -> str:
    project = case.rsplit("-", 1)[0]
    workspace.mkdir(parents=True)
    archive = subprocess.Popen(
        ["git", "--git-dir", str(sources / f"{project}.git"), "archive", f"refs/benchmark/{case}"],
        stdout=subprocess.PIPE,
    )
    subprocess.run(["tar", "-x", "-C", str(workspace)], stdin=archive.stdout, check=True)
    if archive.wait() != 0:
        raise RuntimeError("head commit is missing; run fetch-benchmark-sources.py")
    diff = ROOT / "evals" / "external" / case / "change.diff"
    run(["git", "init", "-q", "-b", "main"], workspace)
    run(["git", "apply", "-R", "--whitespace=nowarn", str(diff)], workspace)
    run(["git", "add", "-A"], workspace)
    run([*GIT, "commit", "-q", "-m", "Base"], workspace)
    run(["git", "checkout", "-q", "-b", "pr"], workspace)
    run(["git", "apply", "--whitespace=nowarn", str(diff)], workspace)
    run(["git", "add", "-A"], workspace)
    run([*GIT, "commit", "-q", "-m", "Pull request"], workspace)
    return run(["git", "diff", "--shortstat", "main...pr"], workspace).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sources", required=True, type=Path, help="directory from fetch-benchmark-sources.py")
    parser.add_argument("--into", required=True, type=Path, help="directory for the workspaces")
    parser.add_argument("--cases", default="", help="comma-separated case IDs (default: all)")
    args = parser.parse_args()

    wanted = set(filter(None, args.cases.split(",")))
    failures = 0
    for item in json.loads(MANIFEST.read_text()):
        case = item["id"]
        if wanted and case not in wanted:
            continue
        workspace = args.into / case
        if (workspace / ".git").exists():
            print(f"{case}: present")
            continue
        if workspace.exists():
            shutil.rmtree(workspace)
        try:
            print(f"{case}: {build(case, args.sources, workspace)}", flush=True)
        except (subprocess.CalledProcessError, RuntimeError) as error:
            detail = getattr(error, "stderr", "") or str(error)
            print(f"{case}: FAILED {detail.strip()[:200]}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

