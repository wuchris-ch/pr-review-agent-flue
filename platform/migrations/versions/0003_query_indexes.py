"""Indexes for bounded outbox polling and repository audit reads."""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_reviews_dispatch", "reviews", ["dispatched", "state"])
    op.create_index("ix_audit_repository", "audit", ["tenant_id", "repository_id", "id"])


def downgrade():
    op.drop_index("ix_audit_repository", table_name="audit")
    op.drop_index("ix_reviews_dispatch", table_name="reviews")
