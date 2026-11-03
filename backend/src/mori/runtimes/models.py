from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class RuntimeBinding(Base):
    __tablename__ = "runtime_bindings"
    __table_args__ = (
        CheckConstraint("desired IN ('active','suspended')", name="ck_runtime_desired"),
        CheckConstraint(
            "status IN ('pending','provisioning','ready','retry','suspending','suspended')",
            name="ck_runtime_status",
        ),
        CheckConstraint("generation >= 1 AND attempts >= 0", name="ck_runtime_counters"),
        Index("ix_runtime_due", "next_check_at", "lease_until"),
    )
    # Retain the binding until an explicit lifecycle cleanup, rather than orphaning resources.
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
    )
    id: Mapped[UUID] = mapped_column(default=uuid4, unique=True)
    namespace: Mapped[str] = mapped_column(String(63))
    resource_name: Mapped[str] = mapped_column(String(63), unique=True)
    desired: Mapped[str] = mapped_column(String(16), default="active")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    generation: Mapped[int] = mapped_column(default=1)
    attempts: Mapped[int] = mapped_column(default=0)
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    next_check_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_token: Mapped[UUID | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
