"""Initial tenant, authorization, review, evidence and audit schema."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "tenants",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("review_limit", sa.Integer(), nullable=False),
        sa.Column("reviews_used", sa.Integer(), nullable=False),
        sa.CheckConstraint("review_limit > 0 AND reviews_used >= 0"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "audit",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("repository_id", sa.String(), nullable=True),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("subject", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "identities",
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
        ),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    op.create_table(
        "repositories",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("suite", sa.JSON(), nullable=False),
        sa.Column("writable_paths", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "id"),
        sa.UniqueConstraint("tenant_id", "name"),
    )
    op.create_table(
        "memberships",
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("repository_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.CheckConstraint("role IN ('viewer', 'reviewer', 'admin')"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "repository_id"],
            ["repositories.tenant_id", "repositories.id"],
        ),
        sa.PrimaryKeyConstraint("tenant_id", "repository_id", "user_id"),
    )
    op.create_table(
        "reviews",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("repository_id", sa.String(), nullable=False),
        sa.Column("pull_request", sa.Integer(), nullable=False),
        sa.Column("base", sa.String(), nullable=False),
        sa.Column("head", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("evidence_digest", sa.String(), nullable=True),
        sa.Column("decision_by", sa.String(), nullable=True),
        sa.Column("dispatched", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            "state IN ('queued','investigating','reproducing','validating','repairing',"
            "'awaiting_approval','approved','rejected','no_finding','inconclusive',"
            "'failed','superseded')"
        ),
        sa.CheckConstraint("length(base) = 40 AND length(head) = 40"),
        sa.CheckConstraint("pull_request > 0"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "repository_id"],
            ["repositories.tenant_id", "repositories.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("repository_id", "pull_request", "base", "head"),
        sa.UniqueConstraint("tenant_id", "id"),
    )
    op.create_table(
        "artifacts",
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("review_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("content", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id", "review_id"],
            ["reviews.tenant_id", "reviews.id"],
        ),
        sa.PrimaryKeyConstraint("tenant_id", "review_id", "name"),
    )


def downgrade():
    raise RuntimeError("Destructive downgrade requires an explicit backup and operator migration")
