#!/usr/bin/env python3
"""Fetch and apply an approved bundle only to its exact, clean local revision."""

import argparse
import hashlib
import json
import os
from urllib.parse import urlparse
import httpx
import subprocess
from pathlib import Path


def apply_bundle(export: dict, repository: Path):
    bundle = export["bundle"]
    encoded = json.dumps(
        bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    if hashlib.sha256(encoded.encode()).hexdigest() != export["evidence_digest"]:
        raise ValueError("evidence digest mismatch")
    if not bundle["passed"] or bundle["head_commit"] != export["head"]:
        raise ValueError("bundle does not contain a validated fix for this commit")

    def git(*arguments, input=None):
        return subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
                str(repository),
                *arguments,
            ],
            input=input,
            text=True,
            capture_output=True,
            check=True,
            timeout=15,
        ).stdout.strip()

    if git("rev-parse", "HEAD") != export["head"]:
        raise ValueError("checkout HEAD does not match the reviewed commit")
    if git("status", "--porcelain"):
        raise ValueError("checkout must be clean before applying an approved fix")
    git("apply", "--check", "--whitespace=error", "-", input=bundle["patch"])
    git("apply", "--whitespace=error", "-", input=bundle["patch"])
    return git("diff", "--stat")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", required=True)
    parser.add_argument("--api", default="http://127.0.0.1:8017")
    parser.add_argument("--repository", type=Path, required=True)
    args = parser.parse_args()
    try:
        url = urlparse(args.api)
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"}):
            raise ValueError("API requires HTTPS or loopback HTTP")
        token = os.environ["REVIEW_PLATFORM_TOKEN"]
        with httpx.Client(base_url=args.api, follow_redirects=False, timeout=20) as client:
            response = client.get(f"/api/reviews/{args.review}/approved-fix",
                                  headers={"Authorization": f"Bearer {token}"})
            response.raise_for_status()
            print(apply_bundle(response.json(), args.repository))
    except (ValueError, KeyError, subprocess.SubprocessError, httpx.HTTPError) as error:
        parser.exit(1, f"Fix not applied: {error}\n")
