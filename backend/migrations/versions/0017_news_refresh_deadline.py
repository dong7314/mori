"""Recover interrupted manual news refreshes without stealing scheduled work."""

import sqlalchemy as sa
from alembic import op

revision = "0017_news_refresh_deadline"
down_revision = "0016_reminder_started_at"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "news_briefings",
        sa.Column("manual_refresh_deadline", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing HTTP refreshes have no durable owner. Allow their next owned read
    # to recover immediately, while scheduled generations keep their job lease.
    op.execute("""
        UPDATE news_briefings AS briefing
        SET manual_refresh_deadline = CURRENT_TIMESTAMP
        WHERE briefing.status = 'loading'
          AND NOT EXISTS (
              SELECT 1 FROM automation_jobs AS job
              WHERE job.feature_id = briefing.feature_id
                AND job.news_generation = briefing.generation
                AND job.status = 'running'
          )
    """)


def downgrade():
    op.drop_column("news_briefings", "manual_refresh_deadline")
