"""Run the review platform with a live model on the authored multi-file scenarios.

Each scenario becomes a local Git mirror: main holds the base, pull request 1 the
regression and pull request 2 a valid alternative change. The scenario's
contract_test.py is withheld from the platform and used afterwards as an
independent check of every proposed fix. The API and worker must be running
with the selected provider configured.

    DATABASE_URL=... uv run --project apps/platform python scripts/platform-live-eval.py --provider live-sol
"""

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx
from review_platform.contracts import digest
from review_platform.db import Identity, Membership, Repository, Tenant, database

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ROOT / "examples/scenarios"
TERMINAL = {
    "awaiting_approval",
    "approved",
    "rejected",
    "inconclusive",
    "no_finding",
    "failed",
    "superseded",
}


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def mirror(name: str, root: Path) -> dict:
    """Create main, PR 1 (regression) and PR 2 (safe) from one scenario directory."""
    path = root / name
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Scenario")
    git(path, "config", "user.email", "scenario@example.invalid")

    def commit(variant, message):
        for item in path.iterdir():
            if item.name != ".git":
                item.unlink()
        for source in (SCENARIOS / name / variant).iterdir():
            shutil.copy(source, path / source.name)
        git(path, "add", "-A")
        git(path, "commit", "-q", "-m", message)
        return git(path, "rev-parse", "HEAD")

    base = commit("base", "Establish the contract")
    heads = {}
    for number, variant in ((1, "regression"), (2, "safe")):
        git(path, "checkout", "-q", "-b", variant, base)
        heads[variant] = commit(variant, f"Change implementation ({variant} variant)")
        git(path, "update-ref", f"refs/pull/{number}/head", heads[variant])
        git(path, "checkout", "-q", "main")
    modules = sorted(p.stem for p in (SCENARIOS / name / "base").glob("*.py"))
    return {"path": path, "base": base, "heads": heads, "modules": modules}


def provision(sessions, tenant, provider, token, scenarios):
    with sessions.begin() as session:
        if not session.get(Tenant, tenant):
            session.add(
                Tenant(
                    id=tenant,
                    name="Scenario evaluation",
                    provider=provider,
                    review_limit=100,
                )
            )
            session.flush()
        for name, info in scenarios.items():
            repo_id = f"{tenant}-{name}"
            if not session.get(Repository, repo_id):
                # No contract test enters the repository; the existing suite is an import check.
                session.add(
                    Repository(
                        id=repo_id,
                        tenant_id=tenant,
                        name=f"scenarios/{name}",
                        path=str(info["path"].resolve()),
                        suite=[
                            "python",
                            "-B",
                            "-c",
                            "import " + ", ".join(info["modules"]),
                        ],
                        writable_paths=[f"{m}.py" for m in info["modules"]],
                    )
                )
                session.flush()
            session.merge(
                Membership(
                    tenant_id=tenant,
                    repository_id=repo_id,
                    user_id="evaluator",
                    role="admin",
                )
            )
        session.merge(
            Identity(token_hash=digest(token), tenant_id=tenant, user_id="evaluator")
        )


def contract_passes(name, files):
    """Run the withheld contract test against a set of source files."""
    with tempfile.TemporaryDirectory() as work:
        for path, text in files.items():
            Path(work, path).write_text(text)
        shutil.copy(
            SCENARIOS / name / "contract_test.py", Path(work, "contract_test.py")
        )
        result = subprocess.run(
            [sys.executable, "-B", "contract_test.py"],
            cwd=work,
            capture_output=True,
            timeout=60,
            check=False,
        )
        return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--provider", required=True)
    parser.add_argument("--api", default="http://127.0.0.1:8017")
    parser.add_argument("--root", type=Path, default=ROOT / ".demo/scenarios")
    parser.add_argument("--out", type=Path, default=ROOT / "evals/platform/runs")
    parser.add_argument("--timeout", type=int, default=2400)
    args = parser.parse_args()

    names = sorted(
        p.name for p in SCENARIOS.iterdir() if (p / "contract_test.py").exists()
    )
    scenarios = {name: mirror(name, args.root) for name in names}
    tenant = f"scenarios-{secrets.token_hex(3)}"
    token = secrets.token_urlsafe(32)
    _, sessions = database(os.environ["DATABASE_URL"])
    provision(sessions, tenant, args.provider, token, scenarios)
    client = httpx.Client(
        base_url=args.api, headers={"Authorization": f"Bearer {token}"}, timeout=30
    )

    jobs = []
    for name, info in scenarios.items():
        for number, variant in ((1, "regression"), (2, "safe")):
            response = client.post(
                f"/api/repositories/{tenant}-{name}/reviews",
                json={
                    "base": info["base"],
                    "head": info["heads"][variant],
                    "pull_request": number,
                },
            )
            response.raise_for_status()
            jobs.append(
                {
                    "scenario": name,
                    "variant": variant,
                    "review": response.json()["id"],
                    "submitted": time.time(),
                }
            )
            print(f"submitted {name}/{variant}", flush=True)

    def wait(job):
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            state = client.get(f"/api/reviews/{job['review']}").json()["state"]
            if state in TERMINAL:
                break
            time.sleep(10)
        job["state"] = state
        job["minutes"] = round((time.time() - job["submitted"]) / 60, 1)

        def artifact(name):
            response = client.get(f"/api/reviews/{job['review']}/artifacts/{name}")
            return response.json() if response.status_code == 200 else None

        investigation = artifact("investigation") or {}
        reproduction = artifact("reproduction") or {}
        intent = artifact("intent") or {}
        fix = artifact("validated_fix") or {}
        proposal = artifact("proposal") or {}
        # Record outcomes and counts only; review text stays in the platform database.
        job["candidates"] = len(investigation.get("candidates", []))
        job["rejected_candidates"] = sum(
            len((artifact(f"agent_{role}") or {}).get("rejected", []))
            for role in ("cross_file", "security", "api_compatibility")
        )
        job["reproduced"] = reproduction.get("confirmed")
        job["intent_accepted"] = intent.get("accepted")
        job["fix_passed_platform_checks"] = fix.get("passed")
        if proposal.get("replacements"):
            head = dict(
                json.loads(json.dumps((artifact("snapshot") or {}).get("head", {})))
            )
            for replacement in proposal["replacements"]:
                head[replacement["file"]] = replacement["content"]
            job["fix_passes_withheld_contract"] = contract_passes(job["scenario"], head)
        print(
            f"{job['scenario']}/{job['variant']}: {job['state']} in {job['minutes']} min",
            flush=True,
        )
        return job

    with ThreadPoolExecutor(len(jobs)) as pool:
        results = list(pool.map(wait, jobs))

    regressions = [j for j in results if j["variant"] == "regression"]
    controls = [j for j in results if j["variant"] == "safe"]
    summary = {
        "provider": args.provider,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "regressions_reproduced": sum(bool(j["reproduced"]) for j in regressions),
        "regressions_reaching_approval": sum(
            j["state"] == "awaiting_approval" for j in regressions
        ),
        "fixes_passing_withheld_contract": sum(
            bool(j.get("fix_passes_withheld_contract")) for j in regressions
        ),
        "regressions": len(regressions),
        "valid_changes_flagged_for_approval": sum(
            j["state"] == "awaiting_approval" for j in controls
        ),
        "valid_changes_reproduced": sum(bool(j["reproduced"]) for j in controls),
        "valid_changes": len(controls),
        "reviews": results,
    }
    directory = args.out / datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "results.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "reviews"}, indent=2))
    print(f"wrote {directory / 'results.json'}")


if __name__ == "__main__":
    main()
