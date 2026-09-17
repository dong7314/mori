from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class AccessChange(Base):
    __tablename__ = "access_changes"
    __table_args__ = (
        CheckConstraint(
            "(action IN ('approve_pro', 'revoke_pro') AND actor_id IS NOT NULL) OR "
            "(action IN ('grant_super_admin', 'revoke_super_admin') AND actor_id IS NULL)",
            name="ck_access_change_actor",
        ),
        Index("ix_access_changes_user_created", "user_id", "created_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
