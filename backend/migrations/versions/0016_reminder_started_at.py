"""Preserve timer progress across restarts, extensions and reconnects."""

import sqlalchemy as sa
from alembic import op

revision = "0016_reminder_started_at"
down_revision = "0015_chat_attachments"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("reminders", sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE reminders SET started_at = created_at")
    op.alter_column("reminders", "started_at", nullable=False, server_default=sa.func.now())


def downgrade():
    op.drop_column("reminders", "started_at")
