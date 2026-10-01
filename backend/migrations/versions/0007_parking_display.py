"""Keep legacy commute behavior and add explicit parking display options."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007_parking_display"
down_revision = "0006_account_settings"
branch_labels = None
depends_on = None


def upgrade():
    # Existing records retain their previous commute-context projection.
    op.add_column(
        "parking_records",
        sa.Column("purpose", sa.String(16), server_default="commute", nullable=False),
    )
    op.add_column(
        "parking_records",
        sa.Column("display_mode", sa.String(16), server_default="scheduled", nullable=False),
    )
    op.add_column(
        "parking_records",
        sa.Column("display_schedule", postgresql.JSONB(none_as_null=True), nullable=True),
    )
    op.alter_column("parking_records", "purpose", server_default="external")
    op.alter_column("parking_records", "display_mode", server_default="always")
    op.create_check_constraint(
        "ck_parking_purpose", "parking_records", "purpose IN ('commute', 'external')"
    )
    op.create_check_constraint(
        "ck_parking_display_mode", "parking_records", "display_mode IN ('always', 'scheduled')"
    )
    op.create_check_constraint(
        "ck_parking_display_schedule",
        "parking_records",
        "display_mode = 'scheduled' OR display_schedule IS NULL",
    )


def downgrade():
    for name in ("ck_parking_display_schedule", "ck_parking_display_mode", "ck_parking_purpose"):
        op.drop_constraint(name, "parking_records", type_="check")
    for name in ("display_schedule", "display_mode", "purpose"):
        op.drop_column("parking_records", name)
