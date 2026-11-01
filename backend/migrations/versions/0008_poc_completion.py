"""PoC result items, manual parking, durable automation, news, market and push."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008_poc_completion"
down_revision = "0007_parking_display"
branch_labels = None
depends_on = None


def owner_columns():
    return [
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade():
    op.add_column(
        "feature_results",
        sa.Column(
            "items",
            postgresql.JSONB(),
            server_default="[]",
            nullable=False,
        ),
    )
    op.drop_constraint("ck_parking_display_mode", "parking_records", type_="check")
    op.create_check_constraint(
        "ck_parking_display_mode",
        "parking_records",
        "display_mode IN ('always', 'scheduled', 'manual')",
    )
    op.create_table(
        "automation_schedule_states",
        sa.Column(
            "feature_id",
            sa.Uuid(),
            sa.ForeignKey("features.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("feature_revision", sa.Integer(), nullable=False),
        sa.Column("next_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "automation_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "feature_id",
            sa.Uuid(),
            sa.ForeignKey("features.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("feature_revision", sa.Integer(), nullable=False),
        sa.Column("feature_snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("news_generation", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "run_id", sa.Uuid(), sa.ForeignKey("chat_turns.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("error_code", sa.String(80), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("feature_id", "scheduled_at", name="uq_automation_occurrence"),
        sa.UniqueConstraint("run_id"),
        sa.CheckConstraint(
            "status IN ('pending','running','completed','failed','cancelled')",
            name="ck_automation_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_automation_attempts"),
    )
    op.create_index("ix_automation_jobs_user_id", "automation_jobs", ["user_id"])
    op.create_index("ix_automation_jobs_feature_id", "automation_jobs", ["feature_id"])
    op.create_index(
        "ix_automation_due", "automation_jobs", ["status", "available_at", "lease_until"]
    )
    op.create_table(
        "news_briefings",
        sa.Column(
            "feature_id",
            sa.Uuid(),
            sa.ForeignKey("features.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("feature_revision", sa.Integer(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("articles", postgresql.JSONB(), nullable=False),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(80), nullable=True),
    )
    op.create_table(
        "market_watches",
        *owner_columns(),
        sa.Column("symbol", sa.String(40), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=True),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", name="uq_market_watch_user"),
    )
    op.create_index("ix_market_watches_user_id", "market_watches", ["user_id"])
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("endpoint_hash", sa.String(64), nullable=False),
        sa.Column("p256dh", sa.String(120), nullable=False),
        sa.Column("auth", sa.String(32), nullable=False),
        sa.Column("device_name", sa.String(80), nullable=False),
        sa.Column("active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "activated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("endpoint_hash", name="uq_push_endpoint_hash"),
    )
    op.create_index("ix_push_subscription_user_active", "push_subscriptions", ["user_id", "active"])
    op.create_table(
        "reminder_deliveries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "reminder_id",
            sa.Uuid(),
            sa.ForeignKey("reminders.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "subscription_id",
            sa.Uuid(),
            sa.ForeignKey("push_subscriptions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("target_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(64), nullable=True),
        sa.Column("provider_status", sa.Integer(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "reminder_id", "subscription_id", "target_at", name="uq_reminder_delivery_target"
        ),
        sa.CheckConstraint(
            "status IN ('queued','processing','retry','sent','failed','skipped')",
            name="ck_reminder_delivery_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_reminder_delivery_attempts"),
    )
    op.create_index(
        "ix_reminder_delivery_due", "reminder_deliveries", ["status", "next_attempt_at"]
    )
    op.create_index(
        "ix_reminder_delivery_user_reminder", "reminder_deliveries", ["user_id", "reminder_id"]
    )


def downgrade():
    for table in (
        "reminder_deliveries",
        "push_subscriptions",
        "market_watches",
        "news_briefings",
        "automation_jobs",
        "automation_schedule_states",
    ):
        op.drop_table(table)
    op.drop_constraint("ck_parking_display_mode", "parking_records", type_="check")
    op.execute("UPDATE parking_records SET display_mode = 'always' WHERE display_mode = 'manual'")
    op.create_check_constraint(
        "ck_parking_display_mode", "parking_records", "display_mode IN ('always', 'scheduled')"
    )
    op.drop_column("feature_results", "items")
