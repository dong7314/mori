"""Explicit user-owned permissions for custom feature execution."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014_feature_actions"
down_revision = "0013_news_summary"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "features",
        sa.Column(
            "allowed_actions", postgresql.JSONB(), nullable=False, server_default='["reply"]'
        ),
    )
    op.create_check_constraint(
        "ck_feature_allowed_actions",
        "features",
        "jsonb_typeof(allowed_actions) = 'array' AND allowed_actions @> '[\"reply\"]'::jsonb "
        'AND allowed_actions <@ \'["reply","note_save","event_save","reminder_save",'
        '"parking_save","document_process"]\'::jsonb',
    )


def downgrade():
    op.execute("UPDATE skill_versions SET definition = definition - 'allowed_actions'")
    op.drop_constraint("ck_feature_allowed_actions", "features", type_="check")
    op.drop_column("features", "allowed_actions")
