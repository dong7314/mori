import asyncio
from datetime import UTC, datetime, timedelta

import httpx
from pydantic import SecretStr

from mori.automation.prewarm import prewarm_once
from mori.features.models import Feature
from mori.operations.service import heartbeat
from mori.operations.speech import transcribe


def test_prewarm_calls_only_assigned_upcoming_runtime_and_deduplicates(
    settings, sessions, accounts
):
    settings.automation_enabled = True
    settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://agent.test"
    settings.hermes_api_key = SecretStr("test-key")
    now = datetime(2030, 1, 1, 23, 58, tzinfo=UTC)
    with sessions.begin() as s:
        for name in ("alice", "bob"):
            s.add(
                Feature(
                    user_id=accounts[name]["user_id"],
                    title="뉴스 정리",
                    description="",
                    work="뉴스 정리",
                    reference="",
                    icon="news",
                    schedule={
                        "time": "09:00",
                        "timezone": "Asia/Seoul",
                        "repeat": "daily",
                        "date": None,
                    },
                    status="active",
                    version=1,
                    revision=1,
                    created_at=now - timedelta(days=1),
                    updated_at=now,
                )
            )
    calls = []

    def provider(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "name": "web",
                        "enabled": True,
                        "configured": True,
                        "tools": ["web_search", "web_extract"],
                    }
                ]
            },
        )

    transport = httpx.MockTransport(provider)
    assert asyncio.run(prewarm_once(sessions, settings, transport=transport, now=now)) == 1
    assert len(calls) == 1 and calls[0].url.path == "/v1/toolsets"
    # The same claimed occurrence cannot be warmed concurrently.
    assert (
        asyncio.run(
            prewarm_once(sessions, settings, transport=transport, now=now - timedelta(seconds=1))
        )
        == 0
    )


def test_capabilities_distinguish_configured_and_worker_alive(client, accounts, sessions):
    settings = client.app.state.settings
    settings.documents_enabled = True
    h = accounts["alice"]["headers"]
    result = client.get("/v1/capabilities", headers=h).json()
    assert result["workers"]["documents"] == {
        "configured": True,
        "status": "unavailable",
        "last_seen_at": None,
        "last_success_at": None,
    }
    heartbeat(sessions, "documents", success=True)
    assert (
        client.get("/v1/capabilities", headers=h).json()["workers"]["documents"]["status"]
        == "running"
    )
    heartbeat(sessions, "documents", error_code="FAILED")
    assert (
        client.get("/v1/capabilities", headers=h).json()["workers"]["documents"]["status"]
        == "degraded"
    )
    assert client.get("/v1/capabilities").status_code == 401


def test_speech_adapter_returns_transcript_without_implicitly_submitting_chat(settings):
    settings.speech_base_url = "https://speech.test"
    settings.speech_api_key = SecretStr("private-key")

    def provider(request):
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer private-key"
        assert b"audio.wav" in request.read()
        return httpx.Response(200, json={"text": "주차 위치를 저장해 줘"})

    result = asyncio.run(
        transcribe(
            settings, b"RIFF-test", "audio/wav", "ko", transport=httpx.MockTransport(provider)
        )
    )
    assert result["text"] == "주차 위치를 저장해 줘" and result["sent_to_chat"] is False


def test_shared_runtime_carries_server_authenticated_user_identity(settings, accounts):
    from mori.chat.runtime import resolve_runtime, runtime_headers

    settings.chat_enabled = True
    settings.shared_hermes_enabled = True
    settings.shared_hermes_base_url = "http://shared-isolation-gateway.test"
    settings.shared_hermes_api_key = SecretStr("a-server-only-key-longer-than-32-bytes")
    first = resolve_runtime(settings, accounts["alice"]["user_id"], "free")
    second = resolve_runtime(settings, accounts["bob"]["user_id"], "free")
    assert first.url == second.url
    assert runtime_headers(first)["X-Mori-User-ID"] == str(accounts["alice"]["user_id"])
    assert runtime_headers(first)["X-Mori-User-ID"] != runtime_headers(second)["X-Mori-User-ID"]


def test_prewarm_leases_only_immediate_capacity_and_next_batch_skips_leased_users(
    settings, sessions
):
    from mori.auth.models import User
    from mori.automation.models import AutomationScheduleState
    from mori.automation.prewarm import claim_warmups

    settings.chat_enabled = True
    settings.shared_hermes_enabled = True
    settings.shared_hermes_base_url = "http://shared-gateway.test"
    settings.shared_hermes_api_key = SecretStr("test-key")
    now = datetime.now(UTC)
    with sessions.begin() as session:
        for i in range(9):
            user = User(display_name=f"scheduled-{i}")
            session.add(user)
            session.flush()
            feature = Feature(
                user_id=user.id,
                title="Scheduled task",
                description="",
                work="Summarize news",
                reference="",
                icon="news",
                status="active",
            )
            session.add(feature)
            session.flush()
            session.add(
                AutomationScheduleState(
                    feature_id=feature.id,
                    feature_revision=feature.revision,
                    next_at=now + timedelta(seconds=60),
                )
            )
    batches = [claim_warmups(sessions, settings, now=now) for _ in range(4)]
    assert [len(batch) for batch in batches] == [4, 4, 1, 0]
    assert len({user_id for batch in batches for user_id, _, _ in batch}) == 9
