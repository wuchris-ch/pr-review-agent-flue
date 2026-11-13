#!/usr/bin/env python3
"""Check out ReviewBench pull requests the way its scripts/try-agent.sh does, without a container.

For each pull request this writes <work>/repos/<key> (a checkout at the pull request head) and
<work>/pr/<key>/{diff.patch,pr.json}. Commits come from the review-bench mirror of the repository,
or from the original repository when the mirror lacks them.

    python3 evals/reviewbench/prepare.py --bench <ReviewBench clone>                 # 25-PR test set
    python3 evals/reviewbench/prepare.py --bench <ReviewBench clone> --manifest evals/reviewbench/fresh-sample.json \
        --work ~/.cache/pr-review-reviewbench-fresh
"""
import argparse
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--bench", required=True, type=Path, help="clone of review-bench/ReviewBench")
parser.add_argument("--work", type=Path, default=Path.home() / ".cache/pr-review-reviewbench")
parser.add_argument("--manifest", type=Path, help="list of pull requests; defaults to the benchmark's test set")
parser.add_argument("--full", action="store_true", help="all 219 pull requests")
args = parser.parse_args()

source = args.manifest or args.bench / ("corpus/manifest.json" if args.full else "corpus/test/test.json")
manifest = json.loads(source.read_text())
env = {**os.environ, "GIT_LFS_SKIP_SMUDGE": "1", "GIT_TERMINAL_PROMPT": "0"}


def git(repo, *command, check=True):
    return subprocess.run(["git", "-C", str(repo), *command], capture_output=True, text=True, env=env, check=check)


def has(repo, *shas):
    return all(
        subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True,
                       env={**env, "GIT_NO_LAZY_FETCH": "1"}).returncode == 0
        for sha in shas
    )


def one(entry):
    nwo, number, base, head = entry["nwo"], entry["pr_number"], entry["base"], entry["head"]
    key = f"{nwo.replace('/', '_')}_{number}-{head[:8]}"
    repo = args.work / "repos" / key
    try:
        if not (repo / ".git").exists():
            repo.mkdir(parents=True, exist_ok=True)
            git(repo, "init", "-q")
            git(repo, "remote", "add", "origin", f"https://github.com/review-bench/{nwo.replace('/', '_')}.git")
            git(repo, "remote", "add", "upstream", f"https://github.com/{nwo}.git")
        for remote in ("origin", "upstream"):
            if not has(repo, base, head):
                git(repo, "fetch", "-q", "--filter=blob:none", remote, base, head, check=False)
        if not has(repo, base, head):
            return key, "FAILED to fetch"
        git(repo, "checkout", "-q", "--force", "--detach", head)
        pr_dir = args.work / "pr" / key
        pr_dir.mkdir(parents=True, exist_ok=True)
        diff = git(repo, "diff", f"{base}...{head}").stdout
        (pr_dir / "diff.patch").write_text(diff)
        (pr_dir / "pr.json").write_text(json.dumps({"repo": entry["repo"], "pr_number": int(number), "base": base,
                                                    "head": head, "nwo": nwo, "key": key}))
        return key, f"ok, diff {len(diff.splitlines())} lines"
    except subprocess.CalledProcessError as error:
        return key, f"FAILED {error.stderr.strip()[:160]}"


with ThreadPoolExecutor(6) as pool:
    for key, status in pool.map(one, manifest):
        print(key, status, flush=True)
