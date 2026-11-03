"""Optional AI news briefing with explicit search-excerpt provenance."""

import sqlalchemy as sa
from alembic import op

revision = "0013_news_summary"
down_revision = "0012_operations_artifacts"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("news_briefings", sa.Column("summary_text", sa.Text(), nullable=True))
    op.add_column("news_briefings", sa.Column("summary_kind", sa.String(40), nullable=True))
    op.add_column("news_briefings", sa.Column("summary_error", sa.String(80), nullable=True))


def downgrade():
    op.drop_column("news_briefings", "summary_error")
    op.drop_column("news_briefings", "summary_kind")
    op.drop_column("news_briefings", "summary_text")
