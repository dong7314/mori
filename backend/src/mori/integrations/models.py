from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base
from mori.organizer.models import OwnedRecord


class NewsBriefing(Base):
    __tablename__ = "news_briefings"
    feature_id: Mapped[UUID] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), primary_key=True
    )
    feature_revision: Mapped[int] = mapped_column()
    generation: Mapped[int] = mapped_column(default=0)
    status: Mapped[str] = mapped_column(String(16), default="empty")
    articles: Mapped[list] = mapped_column(JSONB, default=list)
    collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)


class MarketWatch(OwnedRecord, Base):
    __tablename__ = "market_watches"
    __table_args__ = (UniqueConstraint("user_id", name="uq_market_watch_user"),)
    symbol: Mapped[str] = mapped_column(String(40))
    snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
