"""Create users, access tokens, and idempotent parking records."""

import sqlalchemy as sa
from alembic import op

revision = "0001_parking"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "access_tokens",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_access_tokens_user_id", "access_tokens", ["user_id"])
    op.create_table(
        "parking_records",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("floor", sa.String(32), nullable=True),
        sa.Column("zone", sa.String(64), nullable=True),
        sa.Column("spot", sa.String(64), nullable=True),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.Uuid(), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_parking_user_idempotency"),
        sa.CheckConstraint(
            "floor IS NOT NULL OR zone IS NOT NULL OR spot IS NOT NULL",
            name="ck_parking_has_location",
        ),
    )
    op.create_index("ix_parking_user_latest", "parking_records", ["user_id", "recorded_at", "id"])


def downgrade() -> None:
    op.drop_table("parking_records")
    op.drop_table("access_tokens")
    op.drop_table("users")
