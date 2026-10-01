from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class ParkingRecord(Base):
    __tablename__ = "parking_records"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_parking_user_idempotency"),
        CheckConstraint(
            "floor IS NOT NULL OR zone IS NOT NULL OR spot IS NOT NULL",
            name="ck_parking_has_location",
        ),
        Index("ix_parking_user_latest", "user_id", "recorded_at", "id"),
        CheckConstraint("purpose IN ('commute', 'external')", name="ck_parking_purpose"),
        CheckConstraint("display_mode IN ('always', 'scheduled')", name="ck_parking_display_mode"),
        CheckConstraint(
            "display_mode = 'scheduled' OR display_schedule IS NULL",
            name="ck_parking_display_schedule",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    floor: Mapped[str | None] = mapped_column(String(32), nullable=True)
    zone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    spot: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purpose: Mapped[str] = mapped_column(String(16), default="external", server_default="external")
    display_mode: Mapped[str] = mapped_column(String(16), default="always", server_default="always")
    display_schedule: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
    idempotency_key: Mapped[UUID] = mapped_column()
    request_hash: Mapped[str] = mapped_column(String(64))
