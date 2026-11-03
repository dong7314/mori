"""Durable chat execution independent of HTTP stream lifetime."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010_durable_chat"
down_revision = "0009_runtime_provisioning"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "chat_turns", sa.Column("durable", sa.Boolean(), server_default="false", nullable=False)
    )
    op.create_table(
        "chat_jobs",
        sa.Column(
            "run_id",
            sa.Uuid(),
            sa.ForeignKey("chat_turns.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("history", postgresql.JSONB(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("error_code", sa.String(80), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('queued','processing','retry','completed','failed','cancelled')",
            name="ck_chat_job_status",
        ),
    )
    op.create_index("ix_chat_jobs_user_id", "chat_jobs", ["user_id"])
    op.create_index("ix_chat_jobs_available_at", "chat_jobs", ["available_at"])


def downgrade():
    # Do not leave queued turns looking executable after removing their durable worker records.
    op.execute(
        "UPDATE chat_turns SET status = 'interrupted' WHERE durable = true AND status = 'running'"
    )
    op.drop_table("chat_jobs")
    op.drop_column("chat_turns", "durable")
