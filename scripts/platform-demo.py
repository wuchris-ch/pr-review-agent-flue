"""Submit the provisioned example and wait for Temporal's validated evidence."""
import argparse
import json
import time
from pathlib import Path

import httpx

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--api", default="http://127.0.0.1:8017")
parser.add_argument("--session", type=Path, default=Path(".demo/session.json"))
args = parser.parse_args()
session = json.loads(args.session.read_text())
with httpx.Client(base_url=args.api, headers={"Authorization": f"Bearer {session['token']}"},
                  timeout=20, follow_redirects=False) as client:
    response = client.post(f"/api/repositories/{session['repository_id']}/reviews",
                           json={k: session[k] for k in ("base", "head", "pull_request")})
    response.raise_for_status()
    review = response.json()
    for _ in range(120):
        response = client.get(f"/api/reviews/{review['id']}")
        response.raise_for_status()
        review = response.json()
        if review["state"] in {"awaiting_approval", "approved"}:
            print(json.dumps({key: review[key] for key in
                              ("id", "base", "head", "state", "evidence_digest")}, indent=2))
            break
        if review["state"] in {"failed", "superseded", "inconclusive", "rejected", "no_finding"}:
            raise SystemExit(f"Review stopped: {review['state']}")
        time.sleep(1)
    else:
        raise SystemExit("Review still pending; inspect the worker and Temporal UI")
