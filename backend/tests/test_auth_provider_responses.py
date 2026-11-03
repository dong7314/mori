import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from mori.auth.crypto import opaque_token, pkce_challenge
from mori.auth.models import LoginGrant, OAuthFlow, SocialIdentity, User
from mori.auth.providers import get_provider_client
from mori.main import create_app


class ProviderResponses:
    def __init__(self):
        self.field = None
        self.value = None
        self.calls = []

    def __call__(self, request):
        self.calls.append(request)
        is_token = request.url.path.endswith("/token")
        if self.field == ("token_json" if is_token else "profile_json"):
            return httpx.Response(
                200, content=b'{"nested":' + b"[" * 10000 + b"0" + b"]" * 10000 + b"}"
            )
        if is_token:
            value = {
                "access_token": self.value if self.field == "access_token" else "valid.token_-+/="
            }
        else:
            nickname = self.value if self.field == "nickname" else "한글 café 😀"
            if request.url.host == "openapi.naver.com":
                value = {
                    "resultcode": "00",
                    "response": {
                        "id": self.value if self.field == "subject" else "식별자-é-😀",
                        "nickname": nickname,
                    },
                }
            else:
                value = {
                    "id": 12345,
                    "kakao_account": {"profile": {"nickname": nickname}},
                }
        # Escaped surrogate code points are legal JSON strings but not UTF-8 text.
        return httpx.Response(
            200,
            content=json.dumps(value).encode(),
            headers={"Content-Type": "application/json"},
        )


@pytest.fixture
def provider_responses(settings, sessions):
    provider = ProviderResponses()

    def override():
        with httpx.Client(transport=httpx.MockTransport(provider), trust_env=False) as external:
            yield external

    app = create_app(settings)
    app.dependency_overrides[get_provider_client] = override
    with TestClient(
        app, base_url=settings.auth_public_base_url, raise_server_exceptions=False
    ) as client:
        yield client, provider


def start(client, provider):
    verifier, client_state = opaque_token(), opaque_token()
    response = client.get(
        f"/v1/auth/{provider}/login",
        params={
            "return_url": "https://app.test/auth/callback",
            "code_challenge": pkce_challenge(verifier),
            "client_state": client_state,
        },
        follow_redirects=False,
    )
    assert response.status_code == 302
    state = parse_qs(urlsplit(response.headers["location"]).query)["state"][0]
    return state, client_state, verifier


def callback(client, provider, state):
    return client.get(
        f"/v1/auth/{provider}/callback",
        params={"state": state, "code": "provider-code"},
        follow_redirects=False,
    )


def assert_signup(client, provider):
    state, client_state, verifier = start(client, provider)
    response = callback(client, provider, state)
    assert response.status_code == 302, response.text
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query["state"] == [client_state] and "error" not in query
    exchanged = client.post(
        "/v1/auth/exchange", json={"code": query["code"][0], "code_verifier": verifier}
    )
    assert exchanged.status_code == 200, exchanged.text
    profile = client.get(
        "/v1/me",
        headers={"Authorization": "Bearer " + exchanged.json()["access_token"]},
    )
    assert profile.status_code == 200 and profile.json()["display_name"] == "한글 café 😀"


@pytest.mark.parametrize(
    "provider,field,bad_value",
    [
        ("naver", "access_token", "é"),
        ("kakao", "access_token", "\ud800"),
        ("naver", "access_token", "token\x00suffix"),
        ("kakao", "access_token", "token\r\nsuffix"),
        ("naver", "subject", "\ud800"),
        ("naver", "nickname", "\udfff"),
        ("kakao", "nickname", "\ud800"),
        ("naver", "token_json", None),
        ("kakao", "profile_json", None),
    ],
)
def test_malformed_provider_response_redirects_and_allows_fresh_login(
    provider_responses, sessions, provider, field, bad_value
):
    client, upstream = provider_responses
    upstream.field, upstream.value = field, bad_value
    state, client_state, _ = start(client, provider)
    cookies = dict(client.cookies)
    response = callback(client, provider, state)
    assert response.status_code == 302, response.text
    assert parse_qs(urlsplit(response.headers["location"]).query) == {
        "state": [client_state],
        "error": ["oauth_failed"],
    }
    assert "Max-Age=0" in response.headers["set-cookie"]
    calls = len(upstream.calls)
    assert calls == (1 if field in {"access_token", "token_json"} else 2)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(LoginGrant)) == 0
        assert session.scalar(select(func.count()).select_from(User)) == 0
        assert session.scalar(select(OAuthFlow)).consumed_at is not None
    client.cookies.update(cookies)
    replay = callback(client, provider, state)
    assert replay.status_code == 400 and replay.json()["error"]["code"] == "INVALID_OAUTH_STATE"
    assert len(upstream.calls) == calls
    upstream.field = None
    assert_signup(client, provider)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 1
        assert session.scalar(select(func.count()).select_from(LoginGrant)) == 1
        assert session.scalar(select(LoginGrant)).consumed_at is not None


@pytest.mark.parametrize("provider", ["naver", "kakao"])
def test_valid_unicode_provider_profile_is_preserved(provider_responses, sessions, provider):
    client, _ = provider_responses
    assert_signup(client, provider)
    with sessions() as session:
        assert session.scalar(select(SocialIdentity)).subject == (
            "식별자-é-😀" if provider == "naver" else "12345"
        )
