#!/usr/bin/env python3
"""Fetch the exact head commit of every imported benchmark PR into local bare repositories.

The exploring reviewer reads and searches source at each PR's frozen head revision. This
fetches only those commits (depth 1), one bare repository per project, so searches run
locally with `git grep` and nothing is checked out or executed.

    python3 scripts/fetch-benchmark-sources.py --into ~/.cache/pr-review-benchmark-sources
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "evals" / "external" / "manifest.json"
PR_URL = re.compile(r"^https://github\.com/([^/]+/[^/]+)/pull/(\d+)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--into", required=True, type=Path, help="cache directory for bare repositories")
    parser.add_argument("--cases", default="", help="comma-separated case IDs (default: all)")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    wanted = set(filter(None, args.cases.split(",")))
    args.into.mkdir(parents=True, exist_ok=True)
    failures = 0
    for item in manifest:
        if wanted and item["id"] not in wanted:
            continue
        match = PR_URL.match(item["url"])
        if not match or not SHA.match(item["head"]):
            print(f"{item['id']}: invalid manifest entry", file=sys.stderr)
            failures += 1
            continue
        repository, number = match.group(1), match.group(2)
        project = item["id"].rsplit("-", 1)[0]
        repo = args.into / f"{project}.git"
        if not repo.exists():
            subprocess.run(["git", "init", "--bare", "-q", str(repo)], check=True)
        if git(repo, "cat-file", "-e", f"{item['head']}^{{commit}}").returncode == 0:
            print(f"{item['id']}: present")
            continue
        url = f"https://github.com/{repository}.git"
        fetched = git(repo, "fetch", "--depth", "1", "--no-tags", "-q", url, item["head"])
        if fetched.returncode != 0:
            # Some heads are reachable only through the pull request ref.
            fetched = git(repo, "fetch", "--depth", "1", "--no-tags", "-q", url, f"refs/pull/{number}/head")
        ok = git(repo, "cat-file", "-e", f"{item['head']}^{{commit}}").returncode == 0
        if ok:
            git(repo, "update-ref", f"refs/benchmark/{item['id']}", item["head"])
        print(f"{item['id']}: {'fetched' if ok else 'FAILED ' + fetched.stderr.strip()[:200]}", flush=True)
        failures += 0 if ok else 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

