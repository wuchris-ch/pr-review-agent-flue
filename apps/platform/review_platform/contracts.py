from enum import StrEnum
from hashlib import sha256
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Commit = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class State(StrEnum):
    QUEUED = "queued"
    INVESTIGATING = "investigating"
    REPRODUCING = "reproducing"
    VALIDATING = "validating"
    REPAIRING = "repairing"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    NO_FINDING = "no_finding"
    INCONCLUSIVE = "inconclusive"
    FAILED = "failed"
    SUPERSEDED = "superseded"


TERMINAL = {
    State.APPROVED,
    State.REJECTED,
    State.NO_FINDING,
    State.INCONCLUSIVE,
    State.FAILED,
    State.SUPERSEDED,
}


def digest(data: str) -> str:
    return sha256(data.encode()).hexdigest()


def safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or value != str(path)
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in value
        or any(p.startswith(".") for p in path.parts)
    ):
        raise ValueError("expected a visible repository-relative file path")
    return value


class ReviewRequest(Contract):
    base: Commit
    head: Commit
    pull_request: int = Field(ge=1)


class Reference(Contract):
    file: str
    line: int = Field(ge=1)
    excerpt: str = Field(min_length=1, max_length=2000)
    _path = field_validator("file")(safe_path)


class Candidate(Contract):
    title: str = Field(min_length=1, max_length=160)
    category: Literal["cross_file", "security", "api_compatibility"]
    explanation: str = Field(min_length=1, max_length=4000)
    references: list[Reference] = Field(min_length=1, max_length=8)
    regression_test: str = Field(min_length=1, max_length=16000)


class Investigation(Contract):
    findings: list[Candidate] = Field(max_length=1)


class IntentCheck(Contract):
    accepted: bool
    reason: str = Field(min_length=1, max_length=4000)
    references: list[Reference] = Field(min_length=1, max_length=8)


class Replacement(Contract):
    file: str
    content: str = Field(max_length=64000)
    _path = field_validator("file")(safe_path)


class Repair(Contract):
    rationale: str = Field(min_length=1, max_length=4000)
    replacements: list[Replacement] = Field(min_length=1, max_length=8)


class RunResult(Contract):
    exit_code: int
    log: str
    outcome: Literal["passed", "failed", "timeout", "infrastructure_error"]


class Approval(Contract):
    head: Commit
    evidence_digest: Digest
    decision: Literal["approve", "reject"]


class SettingsUpdate(Contract):
    provider: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")
    review_limit: int = Field(ge=1, le=10000)
