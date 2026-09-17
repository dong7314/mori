from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from mori.database import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("tier IN ('free', 'pro')", name="ck_user_tier"),
        CheckConstraint("role IN ('user', 'super_admin')", name="ck_user_role"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    display_name: Mapped[str] = mapped_column(String(80))
    tier: Mapped[str] = mapped_column(String(16), default="free", server_default="free")
    role: Mapped[str] = mapped_column(String(16), default="user", server_default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AccessToken(Base):
    __tablename__ = "access_tokens"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    session_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("auth_sessions.id", name="fk_access_tokens_session_id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )


class SocialIdentity(Base):
    __tablename__ = "social_identities"
    __table_args__ = (
        UniqueConstraint("provider", "subject", name="uq_social_provider_subject"),
        UniqueConstraint("user_id", "provider", name="uq_social_user_provider"),
        CheckConstraint("provider IN ('naver', 'kakao')", name="ck_social_provider"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    provider: Mapped[str] = mapped_column(String(16))
    subject: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("auth_sessions.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class OAuthFlow(Base):
    __tablename__ = "oauth_flows"
    __table_args__ = (CheckConstraint("provider IN ('naver', 'kakao')", name="ck_oauth_provider"),)

    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16))
    browser_hash: Mapped[str] = mapped_column(String(64))
    code_challenge: Mapped[str] = mapped_column(String(43))
    client_state: Mapped[str] = mapped_column(String(128))
    return_url: Mapped[str] = mapped_column(String(2048))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class LoginGrant(Base):
    __tablename__ = "login_grants"
    __table_args__ = (CheckConstraint("provider IN ('naver', 'kakao')", name="ck_grant_provider"),)

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16))
    subject: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(80))
    code_challenge: Mapped[str] = mapped_column(String(43))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
