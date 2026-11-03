"""Persist private runtime lifecycle and encrypted routing credentials."""

import sqlalchemy as sa
from alembic import op

revision = "0009_runtime_provisioning"
down_revision = "0008_poc_completion"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "runtime_bindings",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
        ),
        sa.Column("id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("namespace", sa.String(63), nullable=False),
        sa.Column("resource_name", sa.String(63), nullable=False, unique=True),
        sa.Column("desired", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("base_url", sa.String(2048), nullable=True),
        sa.Column("error_code", sa.String(80), nullable=True),
        sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("desired IN ('active','suspended')", name="ck_runtime_desired"),
        sa.CheckConstraint(
            "status IN ('pending','provisioning','ready','retry','suspending','suspended')",
            name="ck_runtime_status",
        ),
        sa.CheckConstraint("generation >= 1 AND attempts >= 0", name="ck_runtime_counters"),
    )
    op.create_index("ix_runtime_due", "runtime_bindings", ["next_check_at", "lease_until"])


def downgrade():
    # Does not delete Kubernetes objects or retained PVCs. Stop/reconcile the provisioner first.
    op.drop_table("runtime_bindings")
