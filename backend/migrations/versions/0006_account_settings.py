"""Separate account settings from assistant context, and version profile edits."""

import sqlalchemy as sa
from alembic import op

revision = "0006_account_settings"
down_revision = "0005_screen_api"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users", sa.Column("profile_revision", sa.Integer(), server_default="1", nullable=False)
    )
    op.create_table(
        "account_settings",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("theme", sa.String(16), server_default="system", nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.CheckConstraint("theme IN ('system', 'light', 'dark')", name="ck_account_theme"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade():
    op.drop_table("account_settings")
    op.drop_column("users", "profile_revision")
