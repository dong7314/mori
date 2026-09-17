import hashlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text, update

from mori.auth.crypto import hash_token, opaque_token, pkce_challenge
from mori.auth.models import (
    AccessToken,
    AuthSession,
    LoginGrant,
    OAuthFlow,
    SocialIdentity,
    User,
)
from mori.auth.providers import get_provider_client
from mori.cli import main
from mori.config import Settings
from mori.main import create_app


class ProviderStub:
    def __init__(self):
        self.calls = []
        self.failure = None

    def __call__(self, request):
        self.calls.append(request)
        if self.failure == "timeout":
            raise httpx.ConnectTimeout("provider unavailable", request=request)
        if self.failure == "http":
            return httpx.Response(503, json={"error": "upstream failure"})
        if self.failure == "malformed":
            return httpx.Response(200, text="invalid json")
        if request.url.path.endswith("/token"):
            assert request.method == "POST"
            assert "code=" not in str(request.url)
            form = parse_qs(request.content.decode())
            assert form["client_secret"] and form["grant_type"] == ["authorization_code"]
            provider = "naver" if request.url.host == "nid.naver.com" else "kakao"
            assert form["redirect_uri"] == [f"https://mori.test/v1/auth/{provider}/callback"]
            if provider == "naver":
                assert len(form["state"][0]) == 43
            if self.failure == "token":
                return httpx.Response(200, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "provider-token:" + form["code"][0]})
        code = request.headers["Authorization"].removeprefix("Bearer provider-token:")
        if request.url.host == "openapi.naver.com":
            subject = "naver-subject-" + code if self.failure != "subject" else None
            return httpx.Response(
                200,
                json={
                    "resultcode": "00",
                    "response": {
                        "id": subject,
                        "nickname": None if self.failure == "optional_profile" else "네이버 사용자",
                        "email": "same@example.com",
                    },
                },
            )
        assert request.url.host == "kapi.kakao.com"
        assert request.url.path == "/v2/user/me"
        assert request.url.params["property_keys"] == '["kakao_account.profile"]'
        subject = int.from_bytes(hashlib.sha256(code.encode()).digest()[:7], "big")
        return httpx.Response(
            200,
            json={
                "id": subject if self.failure != "subject" else True,
                "kakao_account": {
                    "profile": {}
                    if self.failure == "optional_profile"
                    else {"nickname": "카카오 사용자"},
                    "email": "same@example.com",
                },
            },
        )


@pytest.fixture
def provider_stub(client):
    stub = ProviderStub()

    def override():
        with httpx.Client(transport=httpx.MockTransport(stub)) as provider_client:
            yield provider_client

    client.app.dependency_overrides[get_provider_client] = override
    return stub


def begin(client, provider="naver", return_url="https://app.test/auth/callback"):
    verifier, client_state = opaque_token(), opaque_token()
    response = client.get(
        f"/v1/auth/{provider}/login",
        params={
            "return_url": return_url,
            "code_challenge": pkce_challenge(verifier),
            "client_state": client_state,
        },
        follow_redirects=False,
    )
    assert response.status_code == 302, response.text
    state = parse_qs(urlsplit(response.headers["location"]).query)["state"][0]
    return {
        "provider": provider,
        "state": state,
        "client_state": client_state,
        "verifier": verifier,
        "response": response,
    }


def finish(client, flow, subject="alice"):
    callback = client.get(
        f"/v1/auth/{flow['provider']}/callback",
        params={
            "state": flow["state"],
            "code": subject,
        },
        follow_redirects=False,
    )
    assert callback.status_code == 302, callback.text
    query = parse_qs(urlsplit(callback.headers["location"]).query)
    assert query["state"] == [flow["client_state"]]
    return query, callback


def signin(client, provider="naver", subject="alice"):
    flow = begin(client, provider)
    query, _ = finish(client, flow, subject)
    response = client.post(
        "/v1/auth/exchange", json={"code": query["code"][0], "code_verifier": flow["verifier"]}
    )
    assert response.status_code == 200, response.text
    return response.json()


def auth(pair):
    return {"Authorization": f"Bearer {pair['access_token']}"}


@pytest.mark.parametrize("provider", ["naver", "kakao"])
def test_full_social_signup_login_and_parking(client, provider_stub, sessions, provider):
    flow = begin(client, provider)
    cookie = flow["response"].headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert "client_secret" not in flow["response"].headers["location"]
    query, callback = finish(client, flow)
    assert "provider-token" not in callback.headers["location"]
    assert "Max-Age=0" in callback.headers["set-cookie"]
    assert callback.headers["Referrer-Policy"] == "no-referrer"
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0
    pair_response = client.post(
        "/v1/auth/exchange", json={"code": query["code"][0], "code_verifier": flow["verifier"]}
    )
    assert pair_response.status_code == 200
    pair = pair_response.json()
    assert pair["expires_in"] == 900 and pair["refresh_expires_in"] == 30 * 86400
    assert pair_response.headers["Cache-Control"] == "no-store"
    me = client.get("/v1/me", headers=auth(pair))
    assert me.status_code == 200 and me.json()["providers"] == [provider]
    saved = client.post(
        "/v1/parking-records",
        headers={**auth(pair), "Idempotency-Key": str(uuid4())},
        json={"spot": "C36"},
    )
    assert saved.status_code == 201
    second = signin(client, provider)
    assert client.get("/v1/me", headers=auth(second)).json()["id"] == me.json()["id"]
    assert client.get("/v1/parking-records/latest", headers=auth(second)).json() == saved.json()
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 1
        assert session.scalar(select(func.count()).select_from(SocialIdentity)) == 1
        assert all(t.token_hash not in pair.values() for t in session.scalars(select(AccessToken)))


def test_same_email_does_not_merge_providers(client, provider_stub):
    naver = signin(client, "naver")
    kakao = signin(client, "kakao")
    assert (
        client.get("/v1/me", headers=auth(naver)).json()["id"]
        != client.get("/v1/me", headers=auth(kakao)).json()["id"]
    )


def test_invalid_state_or_browser_cannot_consume_valid_flow(client, provider_stub):
    flow = begin(client)
    cookies = dict(client.cookies)
    client.cookies.clear()
    missing_cookie = client.get(
        "/v1/auth/naver/callback", params={"state": flow["state"], "code": "alice"}
    )
    assert missing_cookie.status_code == 400
    client.cookies.update(cookies)
    wrong_state = client.get(
        "/v1/auth/naver/callback", params={"state": opaque_token(), "code": "alice"}
    )
    assert wrong_state.status_code == 400
    wrong_provider = client.get(
        "/v1/auth/kakao/callback", params={"state": flow["state"], "code": "alice"}
    )
    assert wrong_provider.status_code == 400
    assert not provider_stub.calls
    query, _ = finish(client, flow)
    assert "code" in query
    repeated = client.get(
        "/v1/auth/naver/callback", params={"state": flow["state"], "code": "alice"}
    )
    assert repeated.status_code == 400
    assert len(provider_stub.calls) == 2


def test_expired_flow_cannot_call_provider(client, provider_stub, sessions):
    flow = begin(client)
    with sessions.begin() as session:
        session.execute(
            update(OAuthFlow).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
    response = client.get(
        "/v1/auth/naver/callback", params={"state": flow["state"], "code": "alice"}
    )
    assert response.status_code == 400 and not provider_stub.calls


def test_denial_does_not_signup_or_reflect_provider_error(client, provider_stub, sessions):
    flow = begin(client)
    denied = client.get(
        "/v1/auth/naver/callback",
        params={
            "state": flow["state"],
            "error": "access_denied",
            "error_description": "private-details",
        },
        follow_redirects=False,
    )
    assert denied.status_code == 302
    assert parse_qs(urlsplit(denied.headers["location"]).query)["error"] == ["oauth_denied"]
    assert "private-details" not in denied.headers["location"]
    assert not provider_stub.calls
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


@pytest.mark.parametrize("failure", ["timeout", "http", "malformed", "token", "subject"])
@pytest.mark.parametrize("provider", ["naver", "kakao"])
def test_provider_failures_never_issue_login_grant(
    client, provider_stub, sessions, failure, provider
):
    provider_stub.failure = failure
    flow = begin(client, provider)
    query, _ = finish(client, flow)
    assert query["error"] == ["oauth_failed"] and "code" not in query
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0
        assert session.scalar(select(func.count()).select_from(LoginGrant)) == 0


def test_login_code_requires_original_verifier_and_is_single_use(client, provider_stub):
    flow = begin(client)
    query, _ = finish(client, flow)
    payload = {"code": query["code"][0], "code_verifier": opaque_token()}
    assert client.post("/v1/auth/exchange", json=payload).status_code == 401
    payload["code_verifier"] = flow["verifier"]
    assert client.post("/v1/auth/exchange", json=payload).status_code == 200
    assert client.post("/v1/auth/exchange", json=payload).status_code == 401


def test_expired_login_grant_does_not_create_user(client, provider_stub, sessions):
    flow = begin(client)
    query, _ = finish(client, flow)
    with sessions.begin() as session:
        session.execute(
            update(LoginGrant).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
    assert (
        client.post(
            "/v1/auth/exchange", json={"code": query["code"][0], "code_verifier": flow["verifier"]}
        ).status_code
        == 401
    )
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


def test_refresh_rotation_replay_and_logout_are_session_scoped(client, provider_stub):
    pair = signin(client)
    other_device = signin(client)
    rotated = client.post("/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert rotated.status_code == 200
    assert rotated.json()["refresh_token"] != pair["refresh_token"]
    assert client.get("/v1/me", headers=auth(rotated.json())).status_code == 200
    replay = client.post("/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert replay.status_code == 401 and replay.json()["error"]["code"] == "REFRESH_TOKEN_REUSED"
    assert client.get("/v1/me", headers=auth(pair)).status_code == 401
    assert client.get("/v1/me", headers=auth(rotated.json())).status_code == 401
    assert client.get("/v1/me", headers=auth(other_device)).status_code == 200
    assert client.post("/v1/auth/logout", headers=auth(other_device)).status_code == 204
    assert client.get("/v1/me", headers=auth(other_device)).status_code == 401
    assert (
        client.post(
            "/v1/auth/refresh", json={"refresh_token": other_device["refresh_token"]}
        ).status_code
        == 401
    )


def test_concurrent_refresh_revokes_family_on_replay(client, provider_stub, settings):
    pair = signin(client)
    barrier = Barrier(2)

    def refresh(_):
        with TestClient(create_app(settings)) as independent:
            barrier.wait(timeout=10)
            return independent.post(
                "/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]}
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(refresh, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 401]
    winner = next(r.json() for r in responses if r.status_code == 200)
    assert client.get("/v1/me", headers=auth(winner)).status_code == 401


def test_concurrent_signup_for_same_social_subject_creates_one_user(
    client, provider_stub, settings, sessions
):
    attempts = []
    for _ in range(2):
        flow = begin(client)
        query, _ = finish(client, flow)
        attempts.append({"code": query["code"][0], "code_verifier": flow["verifier"]})
    barrier = Barrier(2)

    def exchange(payload):
        with TestClient(create_app(settings)) as independent:
            barrier.wait(timeout=10)
            return independent.post("/v1/auth/exchange", json=payload)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(exchange, attempts))
    assert all(r.status_code == 200 for r in responses)
    users = {client.get("/v1/me", headers=auth(r.json())).json()["id"] for r in responses}
    assert len(users) == 1
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 1


def test_legacy_token_without_social_identity_cannot_authenticate(client, sessions):
    with sessions.begin() as session:
        user = User(display_name="legacy")
        session.add(user)
        session.flush()
        family = AuthSession(user_id=user.id, expires_at=datetime.now(UTC) + timedelta(days=1))
        session.add(family)
        session.flush()
        session.add(
            AccessToken(
                user_id=user.id,
                session_id=family.id,
                token_hash=hash_token("legacy-token"),
                expires_at=family.expires_at,
            )
        )
    assert client.get("/v1/me", headers={"Authorization": "Bearer legacy-token"}).status_code == 401


def test_old_migration_revokes_tokens_but_keeps_records(client, sessions):
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.downgrade(config, "0001_parking")
    identifier, token_id, parking_id = uuid4(), uuid4(), uuid4()
    try:
        with sessions.begin() as session:
            session.execute(
                text("INSERT INTO users (id, display_name) VALUES (:id, 'legacy')"),
                {"id": identifier},
            )
            session.execute(
                text(
                    "INSERT INTO access_tokens (id, user_id, token_hash, expires_at) "
                    "VALUES (:id, :user_id, :hash, NOW() + INTERVAL '1 day')"
                ),
                {"id": token_id, "user_id": identifier, "hash": hash_token("legacy-token")},
            )
            session.execute(
                text(
                    "INSERT INTO parking_records "
                    "(id, user_id, spot, idempotency_key, request_hash) "
                    "VALUES (:id, :user_id, 'C36', :key, :hash)"
                ),
                {"id": parking_id, "user_id": identifier, "key": uuid4(), "hash": "x" * 64},
            )
    finally:
        command.upgrade(config, "head")
    with sessions() as session:
        assert session.get(AccessToken, token_id).revoked_at is not None
        assert (
            session.scalar(
                text("SELECT spot FROM parking_records WHERE id = :id"), {"id": parking_id}
            )
            == "C36"
        )
    assert client.get("/v1/me", headers={"Authorization": "Bearer legacy-token"}).status_code == 401


def test_only_registered_providers_and_return_urls_allowed(client, provider_stub):
    response = client.get(
        "/v1/auth/google/login",
        params={
            "return_url": "https://app.test/auth/callback",
            "client_state": opaque_token(),
            "code_challenge": pkce_challenge(opaque_token()),
        },
    )
    assert response.status_code == 422
    response = client.get(
        "/v1/auth/naver/login",
        params={
            "return_url": "https://attacker.example/callback",
            "client_state": opaque_token(),
            "code_challenge": pkce_challenge(opaque_token()),
        },
    )
    assert response.status_code == 400
    assert (
        client.post(
            "/v1/auth/register", json={"email": "a@example.com", "password": "password"}
        ).status_code
        == 404
    )
    assert not provider_stub.calls


def test_missing_provider_config_fails_closed(database_url):
    settings = Settings(
        database_url=database_url,
        naver_client_id="",
        naver_client_secret="",
        kakao_client_id="",
        kakao_client_secret="",
    )
    with TestClient(create_app(settings)) as disabled:
        assert not any(p["enabled"] for p in disabled.get("/v1/auth/providers").json())
        response = disabled.get(
            "/v1/auth/naver/login",
            params={
                "return_url": "http://localhost:5173/auth/callback",
                "client_state": opaque_token(),
                "code_challenge": pkce_challenge(opaque_token()),
            },
        )
        assert response.status_code == 503


@pytest.mark.parametrize(
    "url",
    [
        "https://user:secret@app.test",
        "https://app.test/callback?code=x",
        "javascript:alert(1)",
        "http://public.example/callback",
        "https://app.test/callback#fragment",
    ],
)
def test_unsafe_callback_configuration_rejected(database_url, url):
    with pytest.raises(ValueError):
        Settings(database_url=database_url, auth_return_urls=[url])


def test_cli_revoke_session_and_prune(client, provider_stub, sessions, monkeypatch, capsys):
    pair = signin(client)
    with sessions() as session:
        family = session.scalar(select(AuthSession))
        identifier = str(family.id)
    monkeypatch.setattr(sys, "argv", ["mori", "revoke-session", "--session-id", identifier])
    main()
    assert json.loads(capsys.readouterr().out)["revoked"] is True
    assert client.get("/v1/me", headers=auth(pair)).status_code == 401
    monkeypatch.setattr(sys, "argv", ["mori", "prune-auth"])
    main()
    assert "oauth_flows" in json.loads(capsys.readouterr().out)


@pytest.mark.parametrize("provider", ["naver", "kakao"])
def test_optional_nickname_is_not_required_for_signup(client, provider_stub, provider):
    provider_stub.failure = "optional_profile"
    pair = signin(client, provider)
    assert client.get("/v1/me", headers=auth(pair)).json()["display_name"] == "모리 사용자"


def test_concurrent_exchange_consumes_a_login_grant_only_once(client, provider_stub, settings):
    flow = begin(client)
    query, _ = finish(client, flow)
    barrier = Barrier(2)

    def exchange(_):
        with TestClient(create_app(settings)) as independent:
            barrier.wait(timeout=10)
            return independent.post(
                "/v1/auth/exchange",
                json={
                    "code": query["code"][0],
                    "code_verifier": flow["verifier"],
                },
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(exchange, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 401]


def test_native_callback_code_is_bound_to_original_client(client, provider_stub):
    flow = begin(client, return_url="mori://auth/callback")
    query, callback = finish(client, flow)
    assert callback.headers["location"].startswith("mori://auth/callback?")
    response = client.post(
        "/v1/auth/exchange",
        json={
            "code": query["code"][0],
            "code_verifier": flow["verifier"],
        },
    )
    assert response.status_code == 200


def test_expired_access_can_refresh_but_absolute_session_expiry_cannot(
    client, provider_stub, sessions
):
    pair = signin(client)
    with sessions.begin() as session:
        session.execute(
            update(AccessToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        family = session.scalar(select(AuthSession))
        absolute_expiry = family.expires_at
    assert client.get("/v1/me", headers=auth(pair)).status_code == 401
    refreshed = client.post("/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]})
    assert refreshed.status_code == 200
    with sessions.begin() as session:
        assert session.scalar(select(AuthSession.expires_at)) == absolute_expiry
        session.execute(
            update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    assert client.get("/v1/me", headers=auth(refreshed.json())).status_code == 401
    assert (
        client.post(
            "/v1/auth/refresh", json={"refresh_token": refreshed.json()["refresh_token"]}
        ).status_code
        == 401
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"auth_public_base_url": "https://api.test/prefix"},
        {"auth_public_base_url": "https://api.test", "auth_cookie_secure": False},
        {"auth_public_base_url": "https://api.test:invalid"},
    ],
)
def test_invalid_public_url_or_cookie_settings_rejected(database_url, overrides):
    with pytest.raises(ValueError):
        Settings(database_url=database_url, **overrides)


def test_startup_validation_error_does_not_print_oauth_secrets(database_url):
    with pytest.raises(ValueError) as error:
        Settings(
            database_url=database_url,
            auth_public_base_url="https://api.test",
            auth_cookie_secure=False,
            naver_client_secret="sensitive-naver-secret",
            kakao_client_secret="sensitive-kakao-secret",
        )
    assert "sensitive-naver-secret" not in str(error.value)
    assert "sensitive-kakao-secret" not in str(error.value)
