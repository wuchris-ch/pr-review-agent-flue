import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

from review_platform.contracts import Approval

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("apply_fix", ROOT / "scripts/apply-approved-fix.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_approved_patch_applies_only_to_a_clean_exact_checkout(env, tmp_path):
    env["pipeline"].run(env["review"].id)
    review = env["store"].get(env["review"].id)
    env["store"].decide(
        env["user"],
        review.id,
        Approval(head=review.head, evidence_digest=review.evidence_digest, decision="approve"),
        env["source"].check,
    )
    export = {
        "head": review.head,
        "evidence_digest": review.evidence_digest,
        "bundle": env["store"].artifact(review, "validated_fix"),
    }
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "clone", "--quiet", str(env["repository"]), str(checkout)], check=True)
    assert "pricing.py" in module.apply_bundle(export, checkout)
    assert "return discounted(" in (checkout / "pricing.py").read_text()
    with pytest.raises(ValueError, match="clean"):
        module.apply_bundle(export, checkout)
    tampered = json.loads(json.dumps(export))
    tampered["bundle"]["patch"] += "tampered"
    with pytest.raises(ValueError, match="digest"):
        module.apply_bundle(tampered, checkout)
    subprocess.run(["git", "-C", str(checkout), "restore", "pricing.py"], check=True)
    subprocess.run(
        ["git", "-C", str(checkout), "checkout", "--quiet", env["binding"]["base"]], check=True
    )
    with pytest.raises(ValueError, match="HEAD"):
        module.apply_bundle(export, checkout)
