import hashlib
from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select

from mori.auth.models import AccessToken, User
from mori.database import DatabaseSession
from mori.errors import ApiError

bearer = HTTPBearer(
    auto_error=False,
    description="관리 명령으로 발급한 개인 알파용 토큰. 사용자 ID는 서버에서 결정합니다.",
)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def get_current_user(
    session: DatabaseSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if credentials is None or len(credentials.credentials) > 256:
        raise ApiError(401, "UNAUTHORIZED", "유효한 인증 토큰이 필요합니다.")

    user = session.scalar(
        select(User)
        .join(AccessToken, AccessToken.user_id == User.id)
        .where(
            AccessToken.token_hash == hash_token(credentials.credentials),
            AccessToken.revoked_at.is_(None),
            AccessToken.expires_at > func.now(),
        )
    )
    if user is None:
        raise ApiError(401, "UNAUTHORIZED", "유효한 인증 토큰이 필요합니다.")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
