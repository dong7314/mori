"""User-owned application data. Scheduling intent is separate from delivery."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class OwnedRecord:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Note(OwnedRecord, Base):
    __tablename__ = "notes"
    title: Mapped[str] = mapped_column(String(80))
    body: Mapped[str] = mapped_column(Text)


class CalendarEvent(OwnedRecord, Base):
    __tablename__ = "calendar_events"
    title: Mapped[str] = mapped_column(String(80))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    timezone: Mapped[str] = mapped_column(String(64))
    all_day: Mapped[bool] = mapped_column(default=False)
    category: Mapped[str] = mapped_column(String(16))
    place: Mapped[str] = mapped_column(String(120))
    memo: Mapped[str] = mapped_column(Text)


class Reminder(OwnedRecord, Base):
    __tablename__ = "reminders"
    title: Mapped[str] = mapped_column(String(80))
    target_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    cancelled: Mapped[bool] = mapped_column(default=False)


class Document(OwnedRecord, Base):
    __tablename__ = "documents"
    title: Mapped[str] = mapped_column(String(80))
    filename: Mapped[str] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text)


class UserPreference(Base):
    __tablename__ = "user_preferences"
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(default=1)
    data: Mapped[dict] = mapped_column(JSONB)


class WriteReceipt(Base):
    __tablename__ = "write_receipts"
    __table_args__ = (UniqueConstraint("user_id", "scope", "key", name="uq_write_receipt"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(80))
    key: Mapped[UUID] = mapped_column()
    request_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSONB)
