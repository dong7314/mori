from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select

from mori.auth.crypto import hash_token
from mori.auth.models import AccessToken, AuthSession, SocialIdentity, User
from mori.database import DatabaseSession
from mori.errors import ApiError

bearer = HTTPBearer(
    auto_error=False,
    description="네이버·카카오 로그인 후 발급한 Mori 액세스 토큰",
)


@dataclass
class AuthContext:
    user: User
    session: AuthSession
    token: AccessToken


def get_auth_context(
    session: DatabaseSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> AuthContext:
    if credentials is None or len(credentials.credentials) > 256:
        raise ApiError(401, "UNAUTHORIZED", "유효한 인증 토큰이 필요합니다.")

    authenticated = session.execute(
        select(User, AuthSession, AccessToken)
        .select_from(User)
        .join(AccessToken, AccessToken.user_id == User.id)
        .join(AuthSession, AuthSession.id == AccessToken.session_id)
        .where(
            AccessToken.token_hash == hash_token(credentials.credentials),
            AccessToken.revoked_at.is_(None),
            AccessToken.expires_at > func.now(),
            AuthSession.user_id == User.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > func.now(),
            select(SocialIdentity.id).where(SocialIdentity.user_id == User.id).exists(),
        )
    ).one_or_none()
    if authenticated is None:
        raise ApiError(401, "UNAUTHORIZED", "유효한 인증 토큰이 필요합니다.")
    return AuthContext(*authenticated)


CurrentAuth = Annotated[AuthContext, Depends(get_auth_context)]


def get_current_user(auth: CurrentAuth) -> User:
    return auth.user


CurrentUser = Annotated[User, Depends(get_current_user)]
