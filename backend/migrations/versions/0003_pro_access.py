"""Free/Pro access with explicit super administrator approval."""

import sqlalchemy as sa
from alembic import op

revision = "0003_pro_access"
down_revision = "0002_social_login"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing and new accounts start as free users; never promote the first signup.
    op.add_column("users", sa.Column("tier", sa.String(16), nullable=False, server_default="free"))
    op.add_column("users", sa.Column("role", sa.String(16), nullable=False, server_default="user"))
    op.create_check_constraint("ck_user_tier", "users", "tier IN ('free', 'pro')")
    op.create_check_constraint("ck_user_role", "users", "role IN ('user', 'super_admin')")
    op.create_table(
        "access_changes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("reason", sa.String(300), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.clock_timestamp(),
        ),
        sa.CheckConstraint(
            "(action IN ('approve_pro', 'revoke_pro') AND actor_id IS NOT NULL) OR "
            "(action IN ('grant_super_admin', 'revoke_super_admin') AND actor_id IS NULL)",
            name="ck_access_change_actor",
        ),
    )
    op.create_index(
        "ix_access_changes_user_created", "access_changes", ["user_id", "created_at", "id"]
    )


def downgrade() -> None:
    # Rolling back removes membership state and its history; it does not change parking or tokens.
    op.drop_table("access_changes")
    op.drop_constraint("ck_user_role", "users", type_="check")
    op.drop_constraint("ck_user_tier", "users", type_="check")
    op.drop_column("users", "role")
    op.drop_column("users", "tier")
