"""Temporary auth is scoped to assistant search, never installed on other routers."""

import secrets
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials

from mori.auth.dependencies import bearer, get_auth_context
from mori.database import DatabaseSession
from mori.errors import ApiError


@dataclass(frozen=True)
class SearchIdentity:
    user_id: UUID | None
    test_token: bool = False


def get_search_identity(
    request: Request,
    session: DatabaseSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> SearchIdentity:
    settings = request.app.state.settings
    raw = credentials.credentials if credentials is not None else ""
    if raw.startswith("mori_lab_"):
        if (
            len(raw) == 73
            and raw.isascii()
            and settings.assistant_test_token_enabled
            and secrets.compare_digest(raw, settings.assistant_test_token.get_secret_value())
        ):
            # No user creation, token DB lookup, membership or social-provider call.
            return SearchIdentity(user_id=None, test_token=True)
        raise ApiError(401, "UNAUTHORIZED", "유효한 인증 토큰이 필요합니다.")
    auth = get_auth_context(session, credentials)
    return SearchIdentity(user_id=auth.user.id)


SearchCaller = Annotated[SearchIdentity, Depends(get_search_identity)]
