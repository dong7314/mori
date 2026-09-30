from uuid import UUID

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base
from mori.organizer.models import OwnedRecord


class Feature(OwnedRecord, Base):
    __tablename__ = "features"
    __table_args__ = (UniqueConstraint("user_id", "builtin_key", name="uq_user_builtin"),)
    builtin_key: Mapped[str | None] = mapped_column(String(24), nullable=True)
    title: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(180))
    work: Mapped[str] = mapped_column(Text)
    reference: Mapped[str] = mapped_column(Text)
    icon: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(16))
    schedule: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    version: Mapped[int] = mapped_column(default=1)


class SkillVersion(Base):
    __tablename__ = "skill_versions"
    feature_id: Mapped[UUID] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), primary_key=True
    )
    version: Mapped[int] = mapped_column(primary_key=True)
    definition: Mapped[dict] = mapped_column(JSONB)


class FeatureResult(OwnedRecord, Base):
    __tablename__ = "feature_results"
    feature_id: Mapped[UUID] = mapped_column(
        ForeignKey("features.id", ondelete="CASCADE"), index=True
    )
    feature_version: Mapped[int] = mapped_column()
    run_id: Mapped[UUID] = mapped_column(
        ForeignKey("chat_turns.id", ondelete="CASCADE"), unique=True
    )
    title: Mapped[str] = mapped_column(String(80))
    text: Mapped[str] = mapped_column(Text)
