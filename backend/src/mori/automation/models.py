from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class AutomationScheduleState(Base):
    __tablename__ = "automation_schedule_states"
    feature_id: Mapped[UUID] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), primary_key=True
    )
    feature_revision: Mapped[int] = mapped_column()
    next_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AutomationJob(Base):
    __tablename__ = "automation_jobs"
    __table_args__ = (
        UniqueConstraint("feature_id", "scheduled_at", name="uq_automation_occurrence"),
        CheckConstraint(
            "status IN ('pending','running','completed','failed','cancelled')",
            name="ck_automation_status",
        ),
        CheckConstraint("attempts >= 0", name="ck_automation_attempts"),
        Index("ix_automation_due", "status", "available_at", "lease_until"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    feature_id: Mapped[UUID] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), index=True
    )
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    feature_revision: Mapped[int] = mapped_column()
    feature_snapshot: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[UUID | None] = mapped_column(nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    run_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("chat_turns.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    news_generation: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
