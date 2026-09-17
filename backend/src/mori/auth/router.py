from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from mori.auth.dependencies import CurrentAuth
from mori.auth.flows import FLOW_SECONDS, consume_flow, cookie_name, create_grant, start_flow
from mori.auth.models import SocialIdentity
from mori.auth.providers import AuthSettings, ProviderClient, credentials, verify_profile
from mori.auth.schemas import (
    Challenge,
    ClientState,
    ExchangeRequest,
    LoginCode,
    MeResponse,
    Provider,
    ProviderAvailability,
    RefreshRequest,
    TokenResponse,
)
from mori.auth.sessions import exchange_login, refresh_session, revoke_session
from mori.database import DatabaseSession
from mori.errors import ApiError, ErrorResponse

router = APIRouter(
    prefix="/v1/auth",
    tags=["auth"],
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
profile_router = APIRouter(tags=["auth"])


@router.get("/providers", response_model=list[ProviderAvailability], summary="소셜 로그인 제공자")
def available_providers(settings: AuthSettings):
    result = []
    for provider in Provider:
        try:
            credentials(settings, provider)
            enabled = True
        except ApiError:
            enabled = False
        result.append(ProviderAvailability(provider=provider, enabled=enabled))
    return result


@router.get("/{provider}/login", status_code=302, summary="시스템 브라우저에서 소셜 로그인 시작")
def login(
    provider: Provider,
    session: DatabaseSession,
    settings: AuthSettings,
    return_url: Annotated[str, Query(max_length=2048)],
    code_challenge: Annotated[Challenge, Query(description="클라이언트 verifier의 S256 값")],
    client_state: Annotated[
        ClientState, Query(description="클라이언트에서 생성하고 복귀 시 확인할 난수")
    ],
) -> Response:
    url, state, secret = start_flow(
        session, settings, provider, return_url, code_challenge, client_state
    )
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        cookie_name(state),
        secret,
        max_age=FLOW_SECONDS,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path=f"/v1/auth/{provider}/callback",
    )
    return response


@router.get("/{provider}/callback", status_code=302, summary="소셜 제공자의 서버 콜백")
def callback(
    provider: Provider,
    state: Annotated[LoginCode, Query()],
    request: Request,
    session: DatabaseSession,
    settings: AuthSettings,
    client: ProviderClient,
    code: Annotated[str | None, Query(min_length=1, max_length=4096)] = None,
    error: Annotated[str | None, Query(max_length=256)] = None,
) -> Response:
    flow = consume_flow(session, settings, provider, state, request.cookies.get(cookie_name(state)))
    result = {"state": flow.client_state}
    if error is not None or code is None:
        result["error"] = "oauth_denied"
    else:
        try:
            profile = verify_profile(client, settings, provider, code, state)
            result["code"] = create_grant(session, flow, profile)
        except ApiError:
            # Never reflect provider descriptions or credentials into browser URLs.
            result["error"] = "oauth_failed"
    response = RedirectResponse(flow.return_url + "?" + urlencode(result), status_code=302)
    response.delete_cookie(
        cookie_name(state),
        path=f"/v1/auth/{provider}/callback",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return response


@router.post("/exchange", response_model=TokenResponse, summary="일회용 로그인 코드 교환·가입")
def exchange(payload: ExchangeRequest, session: DatabaseSession, settings: AuthSettings):
    return exchange_login(session, settings, payload)


@router.post("/refresh", response_model=TokenResponse, summary="Mori 토큰 갱신")
def refresh(payload: RefreshRequest, session: DatabaseSession, settings: AuthSettings):
    return refresh_session(session, settings, payload.refresh_token.get_secret_value())


@router.post("/logout", status_code=204, summary="현재 기기의 Mori 로그인 세션 종료")
def logout(auth: CurrentAuth, session: DatabaseSession) -> Response:
    revoke_session(session, auth.session.id)
    return Response(status_code=204)


@profile_router.get(
    "/v1/me",
    response_model=MeResponse,
    responses={401: {"model": ErrorResponse}},
    summary="내 소셜 가입 정보",
)
def me(auth: CurrentAuth, session: DatabaseSession):
    providers = session.scalars(
        select(SocialIdentity.provider)
        .where(SocialIdentity.user_id == auth.user.id)
        .order_by(SocialIdentity.provider)
    ).all()
    return MeResponse(id=auth.user.id, display_name=auth.user.display_name, providers=providers)
