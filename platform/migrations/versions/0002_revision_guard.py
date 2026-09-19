"""Optional authoritative GitHub revision binding for provisioned repositories."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("repositories", sa.Column("github_repository", sa.String(), nullable=True))


def downgrade():
    raise RuntimeError("Removing authoritative revision protection requires operator review")
