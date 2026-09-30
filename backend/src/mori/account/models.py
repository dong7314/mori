from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class AccountSettings(Base):
    __tablename__ = "account_settings"
    __table_args__ = (
        CheckConstraint("theme IN ('system', 'light', 'dark')", name="ck_account_theme"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    theme: Mapped[str] = mapped_column(String(16), default="system", server_default="system")
    revision: Mapped[int] = mapped_column(default=1)
