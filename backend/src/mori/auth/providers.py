from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated
from urllib.parse import urlencode

import httpx
from fastapi import Depends, Request

from mori.auth.schemas import Provider
from mori.config import Settings
from mori.errors import ApiError

AUTHORIZE = {
    Provider.NAVER: "https://nid.naver.com/oauth2.0/authorize",
    Provider.KAKAO: "https://kauth.kakao.com/oauth/authorize",
}
TOKEN = {
    Provider.NAVER: "https://nid.naver.com/oauth2.0/token",
    Provider.KAKAO: "https://kauth.kakao.com/oauth/token",
}
PROFILE = {
    Provider.NAVER: "https://openapi.naver.com/v1/nid/me",
    Provider.KAKAO: "https://kapi.kakao.com/v2/user/me",
}


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


AuthSettings = Annotated[Settings, Depends(get_settings)]


def get_provider_client() -> Iterator[httpx.Client]:
    with httpx.Client(
        timeout=httpx.Timeout(10, connect=5), follow_redirects=False, trust_env=False
    ) as client:
        yield client


ProviderClient = Annotated[httpx.Client, Depends(get_provider_client)]


def credentials(settings: Settings, provider: Provider) -> tuple[str, str]:
    client_id = getattr(settings, f"{provider}_client_id")
    secret = getattr(settings, f"{provider}_client_secret").get_secret_value()
    # Both providers are configured as confidential server-side OAuth clients.
    if not client_id or not secret:
        raise ApiError(503, "SOCIAL_LOGIN_NOT_CONFIGURED", "소셜 로그인 설정이 필요합니다.")
    return client_id, secret


def callback_url(settings: Settings, provider: Provider) -> str:
    return f"{settings.auth_public_base_url}/v1/auth/{provider}/callback"


def authorization_url(settings: Settings, provider: Provider, state: str) -> str:
    client_id, _ = credentials(settings, provider)
    return (
        AUTHORIZE[provider]
        + "?"
        + urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": callback_url(settings, provider),
                "state": state,
            }
        )
    )


@dataclass(frozen=True)
class VerifiedProfile:
    provider: Provider
    subject: str
    display_name: str


def _json(response: httpx.Response) -> dict:
    if response.status_code in {429, 500, 502, 503, 504}:
        raise ApiError(
            503, "OAUTH_PROVIDER_UNAVAILABLE", "소셜 로그인 서버에 잠시 연결할 수 없습니다."
        )
    if not response.is_success:
        raise ApiError(
            401, "OAUTH_REJECTED", "소셜 인증을 완료하지 못했습니다. 다시 로그인해 주세요."
        )
    try:
        value = response.json()
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise ApiError(502, "OAUTH_INVALID_RESPONSE", "소셜 로그인 응답을 확인할 수 없습니다.")
    return value


def verify_profile(
    client: httpx.Client, settings: Settings, provider: Provider, code: str, state: str
) -> VerifiedProfile:
    client_id, secret = credentials(settings, provider)
    data = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": secret,
        "redirect_uri": callback_url(settings, provider),
        "code": code,
    }
    if provider == Provider.NAVER:
        data["state"] = state
    try:
        token_result = _json(client.post(TOKEN[provider], data=data))
        access_token = token_result.get("access_token")
        if token_result.get("error") or not isinstance(access_token, str) or not access_token:
            raise ApiError(
                401, "OAUTH_REJECTED", "소셜 인증을 완료하지 못했습니다. 다시 로그인해 주세요."
            )
        params = (
            {"property_keys": '["kakao_account.profile"]'} if provider == Provider.KAKAO else None
        )
        profile = _json(
            client.get(
                PROFILE[provider],
                headers={"Authorization": f"Bearer {access_token}"},
                params=params,
            )
        )
    except httpx.HTTPError:
        raise ApiError(
            503, "OAUTH_PROVIDER_UNAVAILABLE", "소셜 로그인 서버에 잠시 연결할 수 없습니다."
        ) from None

    if provider == Provider.NAVER:
        info = profile.get("response")
        if profile.get("resultcode") != "00" or not isinstance(info, dict):
            raise ApiError(401, "OAUTH_REJECTED", "네이버 계정을 확인할 수 없습니다.")
        subject = info.get("id")
        nickname = info.get("nickname")
    else:
        identifier = profile.get("id")
        subject = str(identifier) if type(identifier) is int and identifier > 0 else None
        account = profile.get("kakao_account")
        details = account.get("profile") if isinstance(account, dict) else None
        nickname = details.get("nickname") if isinstance(details, dict) else None

    if (
        not isinstance(subject, str)
        or not 1 <= len(subject) <= 255
        or any(ord(char) <= 32 or ord(char) == 127 for char in subject)
    ):
        raise ApiError(502, "OAUTH_INVALID_RESPONSE", "소셜 계정 식별 정보를 확인할 수 없습니다.")
    nickname = nickname if isinstance(nickname, str) else ""
    display_name = "".join(c for c in nickname if ord(c) >= 32 and ord(c) != 127).strip()[:80]
    # Provider tokens, email, phone and the full profile are not persisted or sent to the app.
    return VerifiedProfile(provider, subject, display_name or "모리 사용자")
