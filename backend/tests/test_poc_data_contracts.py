"""Real API regressions for briefing retries, dashboard cards and voice fallback."""

from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, select

from mori.chat.models import ChatTurn
from mori.integrations.models import NewsBriefing
from mori.integrations.router import get_integration_transport
from mori.operations.speech import get_speech_transport


def news_setup(client, accounts):
    client.app.state.settings.searxng_base_url = "https://search.test"
    response = client.put(
        "/v1/news/settings",
        headers=accounts["alice"]["headers"],
        json={"topic": "과학", "time": "09:00", "revision": 0},
    )
    assert response.status_code == 200
    return response.json()


def news_transport(client, status=200, results=None):
    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        lambda _: httpx.Response(
            status,
            json={
                "results": results
                if results is not None
                else [{"url": "https://publisher.test/science", "title": "과학", "content": "관측"}]
            },
        )
    )


def refresh(client, accounts, revision=1):
    return client.post(
        "/v1/news/refresh",
        headers=accounts["alice"]["headers"],
        json={"revision": revision},
    )


def test_failed_news_retry_retains_last_success_and_its_summary(client, accounts, sessions):
    config = news_setup(client, accounts)
    news_transport(client)
    original = refresh(client, accounts).json()
    with sessions.begin() as session:
        row = session.get(NewsBriefing, UUID(config["feature_id"]))
        row.summary_kind, row.summary_text = "ai_search_excerpt_summary", "관측을 정리한 요약"
    news_transport(client, status=500)
    assert refresh(client, accounts).status_code == 502
    state = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert state["status"] == "failed" and state["result_is_stale"] is True
    assert state["articles"] == original["articles"]
    assert state["collected_at"] == original["collected_at"]
    assert state["summary_text"] == "관측을 정리한 요약"
    assert state["feature_status"] == "active"


def test_news_schedule_edit_retains_results_but_new_topic_never_relabels_them(client, accounts):
    news_setup(client, accounts)
    news_transport(client)
    original = refresh(client, accounts).json()
    headers = accounts["alice"]["headers"]
    edited = client.put(
        "/v1/news/settings",
        headers=headers,
        json={"topic": "과학", "time": "10:30", "revision": 1},
    ).json()
    assert edited["articles"] == original["articles"] and edited["status"] == "ready"
    changed = client.put(
        "/v1/news/settings",
        headers=headers,
        json={"topic": "경제", "time": "10:30", "revision": edited["revision"]},
    ).json()
    assert changed["articles"] == []
    news_transport(client, status=500)
    assert refresh(client, accounts, changed["revision"]).status_code == 502
    failed = client.get("/v1/news", headers=headers).json()
    assert failed["status"] == "failed" and failed["topic"] == "경제"
    assert failed["articles"] == [] and failed["collected_at"] is None
    assert failed["result_is_stale"] is False


def test_malformed_only_news_response_is_a_failure_not_an_empty_briefing(client, accounts):
    news_setup(client, accounts)
    news_transport(client)
    original = refresh(client, accounts).json()
    news_transport(client, results=[{"url": "javascript:alert(1)", "title": "잘못된 기사"}])
    response = refresh(client, accounts)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "INVALID_NEWS_RESPONSE"
    state = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert state["articles"] == original["articles"] and state["result_is_stale"]


def test_news_pause_and_resume_keep_last_briefing_but_block_paused_refresh(client, accounts):
    config = news_setup(client, accounts)
    news_transport(client)
    original = refresh(client, accounts).json()
    headers = accounts["alice"]["headers"]
    feature_id = config["feature_id"]
    paused = client.post(
        f"/v1/features/{feature_id}/state",
        headers=headers,
        json={"revision": 1, "status": "paused"},
    )
    assert paused.status_code == 200
    state = client.get("/v1/news", headers=headers).json()
    assert state["feature_status"] == "paused" and state["articles"] == original["articles"]
    assert refresh(client, accounts, state["revision"]).status_code == 409
    resumed = client.post(
        f"/v1/features/{feature_id}/state",
        headers=headers,
        json={"revision": state["revision"], "status": "active"},
    )
    assert resumed.status_code == 200
    state = client.get("/v1/news", headers=headers).json()
    assert state["feature_status"] == "active" and state["articles"] == original["articles"]
    assert state["status"] == "ready" and not state["result_is_stale"]


def test_generic_news_edit_retains_same_topic_and_invalidates_changed_topic(client, accounts):
    config = news_setup(client, accounts)
    news_transport(client)
    original = refresh(client, accounts).json()
    headers = accounts["alice"]["headers"]
    path = f"/v1/features/{config['feature_id']}"
    changed = client.put(
        path,
        headers=headers,
        json={
            "revision": 1,
            "title": "내 뉴스",
            "work": "과학",
            "schedule": {"time": "13:00", "repeat": "daily"},
        },
    )
    assert changed.status_code == 200
    state = client.get("/v1/news", headers=headers).json()
    assert state["articles"] == original["articles"] and state["schedule"]["time"] == "13:00"
    changed = client.put(
        path,
        headers=headers,
        json={"revision": changed.json()["revision"], "title": "경제 뉴스", "work": "경제"},
    )
    assert changed.status_code == 200
    state = client.get("/v1/news", headers=headers).json()
    assert state["articles"] == [] and state["status"] == "empty"


def test_kis_watch_rejects_unsupported_selection_without_overwriting_existing(client, accounts):
    headers = accounts["alice"]["headers"]
    client.app.state.settings.kis_enabled = True
    saved = client.put(
        "/v1/market/settings", headers=headers, json={"revision": 0, "symbol": "aapl"}
    )
    assert saved.status_code == 200
    denied = client.put(
        "/v1/market/settings", headers=headers, json={"revision": 1, "symbol": "UNLISTED"}
    )
    assert denied.status_code == 422
    assert denied.json()["error"]["code"] == "UNSUPPORTED_MARKET_SYMBOL"
    assert client.get("/v1/market/settings", headers=headers).json()["symbol"] == "AAPL"


def dashboard(client, accounts, at):
    response = client.get("/v1/dashboard", headers=accounts["alice"]["headers"], params={"at": at})
    assert response.status_code == 200, response.text
    return [item for group in response.json()["groups"] for item in group["items"]]


def test_builtin_dashboard_windows_and_detail_destinations_match_saved_settings(client, accounts):
    news_setup(client, accounts)
    headers = accounts["alice"]["headers"]
    client.put("/v1/market/settings", headers=headers, json={"revision": 0, "symbol": "AAPL"})
    response = client.post(
        "/v1/features",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={
            "title": "관심 주가",
            "work": "시세",
            "builtin_key": "stock",
            "schedule": {"time": "10:00", "repeat": "daily"},
        },
    )
    assert response.status_code == 201, response.text
    assert dashboard(client, accounts, "2026-11-03T08:29:59+09:00") == []
    news = dashboard(client, accounts, "2026-11-03T08:30:00+09:00")
    assert len(news) == 1 and news[0]["builtin_key"] == "news"
    assert news[0]["detail_url"] == "/v1/news" and news[0]["description"] == "과학"
    assert {
        row["builtin_key"] for row in dashboard(client, accounts, "2026-11-03T11:59:59+09:00")
    } == {"news", "stock"}
    stock = dashboard(client, accounts, "2026-11-03T12:00:00+09:00")
    assert len(stock) == 1 and stock[0]["builtin_key"] == "stock"
    assert stock[0]["description"] == "AAPL" and stock[0]["detail_url"] == "/v1/market/quote"
    assert stock[0]["show_from"] == "2026-11-03T01:00:00Z"
    assert len(dashboard(client, accounts, "2026-11-03T15:59:59+09:00")) == 1
    assert dashboard(client, accounts, "2026-11-03T16:00:00+09:00") == []


def test_midnight_news_card_appears_previous_day_without_running_collection(client, accounts):
    news_setup(client, accounts)
    headers = accounts["alice"]["headers"]
    client.put(
        "/v1/news/settings",
        headers=headers,
        json={"revision": 1, "topic": "과학", "time": "00:10"},
    )
    rows = dashboard(client, accounts, "2026-11-03T23:40:00+09:00")
    assert len(rows) == 1 and rows[0]["current"]
    assert rows[0]["at"] == "2026-11-03T15:10:00Z"
    assert client.get("/v1/news", headers=headers).json()["status"] == "empty"


def test_stock_evening_schedule_is_not_lost_to_default_daytime_cutoff(client, accounts):
    response = client.post(
        "/v1/features",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
        json={
            "title": "저녁 관심 주가",
            "work": "시세",
            "builtin_key": "stock",
            "schedule": {"time": "18:00", "repeat": "daily"},
        },
    )
    assert response.status_code == 201
    assert dashboard(client, accounts, "2026-11-03T17:59:59+09:00") == []
    rows = dashboard(client, accounts, "2026-11-03T18:00:00+09:00")
    assert len(rows) == 1 and rows[0]["builtin_key"] == "stock"
    assert rows[0]["show_until"] == "2026-11-03T10:30:00Z"
    assert dashboard(client, accounts, "2026-11-03T19:30:00+09:00") == []


def speech_transport(client, handler):
    client.app.state.settings.speech_base_url = "https://speech.test"
    client.app.dependency_overrides[get_speech_transport] = lambda: httpx.MockTransport(handler)


def speech(client, accounts, **kwargs):
    return client.post(
        "/v1/speech/transcriptions",
        headers={**accounts["alice"]["headers"], "Content-Type": "audio/webm;codecs=opus"},
        content=b"recorded-audio",
        **kwargs,
    )


def test_voice_route_preserves_editable_transcript_without_submitting_chat(
    client, accounts, sessions
):
    speech_transport(
        client, lambda _: httpx.Response(200, json={"text": "  주차 위치 기억해 줘  "})
    )
    response = speech(client, accounts)
    assert response.status_code == 200
    assert response.json() == {
        "text": "주차 위치 기억해 줘",
        "language": "ko",
        "sent_to_chat": False,
    }
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ChatTurn)) == 0


@pytest.mark.parametrize(
    "provider_response,code,status",
    [
        (httpx.Response(200, json={"text": " \n "}), "NO_SPEECH", 422),
        (httpx.Response(200, json={"text": "\u0000"}), "SPEECH_PROVIDER_FAILED", 502),
        (
            httpx.Response(200, content=b'{"text":"bad\\ud800"}'),
            "SPEECH_PROVIDER_FAILED",
            502,
        ),
        (httpx.Response(200, content=b"{" * 1001), "SPEECH_PROVIDER_FAILED", 502),
        (httpx.Response(429, text="private-provider-secret"), "SPEECH_PROVIDER_RATE_LIMITED", 503),
        (
            httpx.Response(302, headers={"Location": "https://elsewhere.test"}),
            "SPEECH_PROVIDER_FAILED",
            502,
        ),
    ],
)
def test_voice_route_reports_retryable_failure_without_false_success(
    client, accounts, provider_response, code, status
):
    speech_transport(client, lambda _: provider_response)
    response = speech(client, accounts)
    assert response.status_code == status and response.json()["error"]["code"] == code
    assert "private-provider-secret" not in response.text


def test_voice_provider_timeout_is_bounded_and_classified(client, accounts):
    def timeout(request):
        raise httpx.ReadTimeout("private-provider-secret", request=request)

    speech_transport(client, timeout)
    response = speech(client, accounts)
    assert response.status_code == 504 and response.json()["error"]["code"] == "SPEECH_TIMEOUT"
    assert "private-provider-secret" not in response.text


def test_voice_invalid_request_never_reaches_provider(client, accounts):
    def forbidden(_):
        raise AssertionError("Invalid audio must not reach the provider")

    speech_transport(client, forbidden)
    assert client.post("/v1/speech/transcriptions", content=b"audio").status_code == 401
    headers = accounts["alice"]["headers"]
    assert (
        client.post("/v1/speech/transcriptions", headers=headers, content=b"audio").status_code
        == 415
    )
    client.app.state.settings.speech_max_bytes = 1024
    for body, status in ((b"", 422), (b"a" * 1025, 413)):
        response = client.post(
            "/v1/speech/transcriptions",
            headers={**headers, "Content-Type": "audio/wav"},
            content=body,
        )
        assert response.status_code == status
    assert speech(client, accounts, params={"language": "Korean"}).status_code == 422
