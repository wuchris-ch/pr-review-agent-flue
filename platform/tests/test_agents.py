import json
import subprocess

import pytest

from review_platform.agents import Agents, FlueAgents
from review_platform.service import Problem


def test_model_process_has_only_provider_credentials_and_structured_role(monkeypatch):
    observed = {}
    monkeypatch.setenv("GITHUB_TOKEN", "must-not-escape")
    monkeypatch.setenv("DATABASE_URL", "must-not-escape")

    def run(command, **options):
        observed.update(options)
        return subprocess.CompletedProcess(command, 0, stdout='{"findings":[]}', stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    agents = FlueAgents({"team": {"MODEL_GATEWAY_API_KEY": "model-only"}})
    assert agents.investigate("team", "security", {"head": {}}).findings == []
    assert "GITHUB_TOKEN" not in observed["env"] and "DATABASE_URL" not in observed["env"]
    envelope = json.loads(observed["input"])
    assert envelope["role"] == "security" and "schema" in envelope


def test_invalid_model_output_and_unconfigured_fixture_fail_closed(monkeypatch):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            [], 0, stdout='{"findings":"invented"}'
        ),
    )
    with pytest.raises(Problem, match="invalid"):
        FlueAgents({"team": {}}).investigate("team", "security", {})
    with pytest.raises(Problem, match="disabled"):
        Agents({}).for_provider("fixture")
