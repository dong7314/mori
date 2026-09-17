import hmac
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from mori.auth.crypto import hash_token, opaque_token, pkce_challenge
from mori.auth.models import (
    AccessToken,
    AuthSession,
    LoginGrant,
    RefreshToken,
    SocialIdentity,
    User,
)
from mori.auth.schemas import ExchangeRequest, TokenResponse
from mori.config import Settings
from mori.errors import ApiError


def database_now(session: Session) -> datetime:
    return session.scalar(select(func.clock_timestamp()))


def _social_user(session: Session, grant: LoginGrant) -> User:
    identity_query = select(SocialIdentity).where(
        SocialIdentity.provider == grant.provider, SocialIdentity.subject == grant.subject
    )
    identity = session.scalar(identity_query)
    if identity is not None:
        return session.get(User, identity.user_id)
    try:
        # A conflicting concurrent signup rolls back both the identity and its new user.
        with session.begin_nested():
            user = User(display_name=grant.display_name)
            session.add(user)
            session.flush()
            session.add(
                SocialIdentity(user_id=user.id, provider=grant.provider, subject=grant.subject)
            )
            session.flush()
        return user
    except IntegrityError as error:
        if (
            getattr(getattr(error.orig, "diag", None), "constraint_name", None)
            != "uq_social_provider_subject"
        ):
            raise
        identity = session.scalar(identity_query)
        if identity is None:
            raise
        return session.get(User, identity.user_id)


def _issue_pair(
    session: Session, auth_session: AuthSession, settings: Settings, now: datetime
) -> TokenResponse:
    access = opaque_token("mori_at_")
    refresh = opaque_token("mori_rt_")
    access_expiry = min(
        auth_session.expires_at, now + timedelta(seconds=settings.auth_access_token_seconds)
    )
    session.add(
        AccessToken(
            user_id=auth_session.user_id,
            session_id=auth_session.id,
            token_hash=hash_token(access),
            expires_at=access_expiry,
        )
    )
    session.add(
        RefreshToken(
            session_id=auth_session.id,
            token_hash=hash_token(refresh),
            expires_at=auth_session.expires_at,
        )
    )
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=max(0, int((access_expiry - now).total_seconds())),
        refresh_expires_in=max(0, int((auth_session.expires_at - now).total_seconds())),
    )


def exchange_login(session: Session, settings: Settings, payload: ExchangeRequest) -> TokenResponse:
    grant = session.scalar(
        select(LoginGrant).where(LoginGrant.code_hash == hash_token(payload.code)).with_for_update()
    )
    now = database_now(session)
    if grant is None or grant.consumed_at is not None or grant.expires_at <= now:
        raise ApiError(401, "INVALID_LOGIN_CODE", "로그인 코드가 만료되었거나 이미 사용되었습니다.")
    if not hmac.compare_digest(grant.code_challenge, pkce_challenge(payload.code_verifier)):
        raise ApiError(401, "INVALID_LOGIN_CODE", "로그인을 시작한 기기에서 다시 시도해 주세요.")
    user = _social_user(session, grant)
    grant.consumed_at = now
    auth_session = AuthSession(
        user_id=user.id, expires_at=now + timedelta(days=settings.auth_session_days)
    )
    session.add(auth_session)
    session.flush()
    result = _issue_pair(session, auth_session, settings, now)
    session.commit()
    return result


def refresh_session(session: Session, settings: Settings, raw_token: str) -> TokenResponse:
    if not 1 <= len(raw_token) <= 256:
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "다시 로그인해 주세요.")
    candidate = session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
    )
    if candidate is None:
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "다시 로그인해 주세요.")
    # Lock the family before reading used_at so concurrent rotations and logout serialize.
    family = session.scalar(
        select(AuthSession).where(AuthSession.id == candidate.session_id).with_for_update()
    )
    if family is None:
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "다시 로그인해 주세요.")
    session.refresh(candidate)
    now = database_now(session)
    if family.revoked_at is not None or family.expires_at <= now or candidate.expires_at <= now:
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "다시 로그인해 주세요.")
    if candidate.used_at is not None:
        family.revoked_at = now
        session.commit()
        raise ApiError(
            401, "REFRESH_TOKEN_REUSED", "이미 사용한 갱신 토큰입니다. 다시 로그인해 주세요."
        )
    if (
        session.scalar(
            select(SocialIdentity.id).where(SocialIdentity.user_id == family.user_id).limit(1)
        )
        is None
    ):
        raise ApiError(401, "INVALID_REFRESH_TOKEN", "소셜 계정으로 다시 로그인해 주세요.")
    candidate.used_at = now
    result = _issue_pair(session, family, settings, now)
    session.commit()
    return result


def revoke_session(session: Session, session_id: UUID) -> None:
    family = session.scalar(
        select(AuthSession).where(AuthSession.id == session_id).with_for_update()
    )
    if family is not None:
        family.revoked_at = database_now(session)
        session.commit()
