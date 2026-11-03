"""Explicit owned document references on chat turns."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0015_chat_attachments"
down_revision = "0014_feature_actions"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "chat_turns", sa.Column("attachments", JSONB(), nullable=False, server_default="[]")
    )


def downgrade():
    op.drop_column("chat_turns", "attachments")
