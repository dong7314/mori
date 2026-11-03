"""Verified subscriptions and durable payment orders, retaining administrator access."""

import sqlalchemy as sa
from alembic import op

revision = "0011_billing"
down_revision = "0010_durable_chat"
branch_labels = None
depends_on = None


def user_column(primary=False):
    return sa.Column(
        "user_id",
        sa.Uuid(),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=primary,
        nullable=False,
    )


def upgrade():
    op.create_table(
        "billing_entitlements",
        user_column(True),
        sa.Column("admin_granted", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.execute(
        "INSERT INTO billing_entitlements (user_id, admin_granted) "
        "SELECT id, true FROM users WHERE tier = 'pro'"
    )
    op.create_table(
        "billing_subscriptions",
        user_column(True),
        sa.Column("customer_key", sa.String(100), nullable=False, unique=True),
        sa.Column("billing_key", sa.Text(), nullable=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("cancel_at_period_end", sa.Boolean(), nullable=False),
        sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "ix_billing_subscriptions_current_period_end",
        "billing_subscriptions",
        ["current_period_end"],
    )
    op.create_table(
        "billing_checkouts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        user_column(),
        sa.Column("request_key", sa.Uuid(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=True),
        sa.UniqueConstraint("user_id", "request_key", name="uq_billing_checkout_request"),
    )
    op.create_index("ix_billing_checkouts_user_id", "billing_checkouts", ["user_id"])
    op.create_table(
        "billing_orders",
        sa.Column("id", sa.Uuid(), primary_key=True),
        user_column(),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("auth_key", sa.Text(), nullable=True),
        sa.Column("payment_key", sa.String(200), nullable=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(80), nullable=True),
        sa.Column("verify_requested", sa.Boolean(), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("user_id", "period_start", name="uq_billing_period"),
    )
    op.create_index("ix_billing_orders_user_id", "billing_orders", ["user_id"])
    op.create_index(
        "ix_billing_order_due", "billing_orders", ["status", "available_at", "lease_until"]
    )


def downgrade():
    # Paid grants must not turn into permanent administrator grants on downgrade.
    op.execute(
        "UPDATE users SET tier='free' WHERE id IN "
        "(SELECT user_id FROM billing_entitlements WHERE admin_granted=false)"
    )
    op.drop_table("billing_orders")
    op.drop_table("billing_checkouts")
    op.drop_table("billing_subscriptions")
    op.drop_table("billing_entitlements")
