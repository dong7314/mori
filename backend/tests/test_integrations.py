import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select

from mori.features.models import Feature
from mori.features.schemas import FeatureUpdate
from mori.features.service import update_feature
from mori.integrations.router import get_integration_transport


def news_settings(client, accounts, **changes):
    return client.put(
        "/v1/news/settings",
        headers=accounts["alice"]["headers"],
        json={"topic": "과학", "time": "09:00", "revision": 0, **changes},
    )


def provider(client, handler):
    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        handler
    )


def article(url="https://publisher.test/story"):
    return {
        "url": url,
        "title": "<b>과학 소식</b>",
        "content": "관측 &amp; 연구",
        "publishedDate": "2026-11-01T09:00:00+09:00",
    }


def refresh(client, accounts, revision=1):
    return client.post(
        "/v1/news/refresh", json={"revision": revision}, headers=accounts["alice"]["headers"]
    )


def test_news_settings_are_persistent_owned_and_revision_checked(client, accounts, sessions):
    h = accounts["alice"]["headers"]
    assert client.get("/v1/news").status_code == 401
    assert client.get("/v1/news", headers=h).json()["revision"] == 0
    assert news_settings(client, accounts).status_code == 200
    state = client.get("/v1/news", headers=h).json()
    assert state["topic"] == "과학" and state["schedule"]["repeat"] == "daily"
    assert state["schedule"]["time"] == "09:00"
    assert state["configured"] is False and state["status"] == "empty"
    assert news_settings(client, accounts).status_code == 409
    assert client.get("/v1/news", headers=accounts["bob"]["headers"]).json()["revision"] == 0
    with sessions() as session:
        rows = session.scalars(select(Feature).where(Feature.builtin_key == "news")).all()
        assert len(rows) == 1 and rows[0].user_id == accounts["alice"]["user_id"]
    assert refresh(client, accounts).status_code == 503
    invalid = news_settings(
        client, accounts, revision=1, schedule={"time": "09:00", "repeat": "daily"}
    )
    assert invalid.status_code == 422


def test_news_fetch_persists_structured_deduplicated_real_excerpts(client, accounts):
    client.app.state.settings.searxng_base_url = "http://search.test"
    news_settings(client, accounts)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/search" and request.url.params["categories"] == "news"
        assert request.url.params["q"] == "과학" and request.url.params["format"] == "json"
        return httpx.Response(
            200,
            json={
                "results": [
                    article(),
                    article(),
                    article("javascript:alert(1)"),
                    {"url": "https://bad.test"},
                ]
            },
        )

    provider(client, handler)
    response = refresh(client, accounts)
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["status"] == "ready" and len(state["articles"]) == 1
    item = state["articles"][0]
    assert item["title"] == "과학 소식" and item["summary"] == "관측 & 연구"
    assert item["summary_type"] == "search_excerpt" and item["source"] == "publisher.test"
    assert state["collected_at"] and item["published_at"]
    saved = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert saved == state
    assert refresh(client, accounts).json()["articles"][0]["id"] == item["id"]
    assert len(calls) == 2


@pytest.mark.parametrize(
    "response,expected",
    [
        (httpx.Response(500, text="secret-provider-token"), "PROVIDER_UNAVAILABLE"),
        (httpx.Response(429, text="secret-provider-token"), "PROVIDER_RATE_LIMITED"),
        (httpx.Response(200, json={"not_results": []}), "INVALID_NEWS_RESPONSE"),
        (
            httpx.Response(200, json={"results": [], "unresponsive_engines": [["x", "timeout"]]}),
            "NEWS_SEARCH_FAILED",
        ),
    ],
)
def test_news_failures_are_persisted_without_false_success_or_secret_leaks(
    client,
    accounts,
    response,
    expected,
):
    client.app.state.settings.searxng_base_url = "http://search.test"
    news_settings(client, accounts)
    provider(client, lambda request: response)
    result = refresh(client, accounts)
    assert result.status_code in (502, 503) and result.json()["error"]["code"] == expected
    state = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert state["status"] == "failed" and state["error_code"] == expected
    assert "secret-provider-token" not in result.text and "secret-provider-token" not in str(state)


def test_news_changed_definition_cannot_publish_stale_request(client, accounts, sessions):
    client.app.state.settings.searxng_base_url = "http://search.test"
    news_settings(client, accounts)

    def handler(request):
        with sessions.begin() as session:
            row = session.scalar(select(Feature).where(Feature.builtin_key == "news"))
            update_feature(
                session,
                row.user_id,
                row.id,
                FeatureUpdate(
                    revision=row.revision,
                    title=row.title,
                    work="다른 주제",
                    icon="news",
                ),
            )
        return httpx.Response(200, json={"results": [article()]})

    provider(client, handler)
    result = refresh(client, accounts)
    assert result.status_code == 409 and result.json()["error"]["code"] == "NEWS_REFRESH_SUPERSEDED"
    state = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert state["topic"] == "다른 주제" and state["articles"] == []


def test_news_empty_search_is_not_sample_data(client, accounts):
    client.app.state.settings.searxng_base_url = "http://search.test"
    news_settings(client, accounts)
    provider(client, lambda request: httpx.Response(200, json={"results": []}))
    result = refresh(client, accounts)
    assert result.status_code == 200 and result.json()["articles"] == []


def test_market_watch_is_owned_persistent_and_revision_checked(client, accounts):
    h = accounts["alice"]["headers"]
    initial = client.get("/v1/market/settings", headers=h).json()
    assert initial["symbol"] is None and initial["revision"] == 0
    payload = {"symbol": "aapl", "revision": 0}
    saved = client.put("/v1/market/settings", headers=h, json=payload).json()
    assert saved["symbol"] == "AAPL" and saved["revision"] == 1
    assert client.put("/v1/market/settings", headers=h, json=payload).status_code == 409
    assert (
        client.get("/v1/market/settings", headers=accounts["bob"]["headers"]).json()["symbol"]
        is None
    )
    assert client.get("/v1/market/quote", headers=h).status_code == 503
    assert client.get("/v1/market/quote", headers=accounts["bob"]["headers"]).status_code == 422
    assert client.get("/v1/market/snapshot", headers=h).json() is None
    assert client.get("/v1/market/quote").status_code == 401


def quote_data():
    return {
        "symbol": "AAPL",
        "currency": "USD",
        "price": 210.0,
        "previous_close": 200.0,
        "as_of": "2026-11-01T00:00:00Z",
    }


def candle_data(range="day"):
    return {
        "symbol": "AAPL",
        "range": range,
        "currency": "USD",
        "as_of": "2026-11-01T00:00:00Z",
        "candles": [
            {
                "at": "2026-10-31T00:00:00Z",
                "open": 199,
                "high": 215,
                "low": 198,
                "close": 210,
                "volume": 1000,
            }
        ],
    }


def test_market_provider_quote_and_all_chart_ranges(client, accounts):
    settings = client.app.state.settings
    settings.market_data_base_url = "https://market.test"
    settings.market_data_api_key = SecretStr("market-key-never-exposed")
    settings.market_data_provider = "Test gateway"
    h = accounts["alice"]["headers"]
    client.put("/v1/market/settings", headers=h, json={"symbol": "AAPL", "revision": 0})

    def handler(request):
        assert request.headers["authorization"] == "Bearer market-key-never-exposed"
        assert request.url.params["symbol"] == "AAPL"
        data = (
            quote_data()
            if request.url.path == "/quote"
            else candle_data(request.url.params["range"])
        )
        return httpx.Response(200, json=data)

    provider(client, handler)
    response = client.get("/v1/market/quote", headers=h)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["change"] == 10 and result["change_percent"] == 5
    assert result["provider"] == "Test gateway"
    for range in ("day", "week", "month"):
        response = client.get("/v1/market/candles", headers=h, params={"range": range})
        assert response.status_code == 200 and response.json()["range"] == range
        assert response.json()["candles"][0]["close"] == 210
    assert client.get("/v1/market/candles", headers=h, params={"range": "year"}).status_code == 422
    assert "market-key-never-exposed" not in str(result)


@pytest.mark.parametrize(
    "change",
    [
        {"symbol": "OTHER"},
        {"price": float("inf")},
        {"price": -1},
        {"as_of": "2026-11-01"},
    ],
)
def test_invalid_market_quote_is_rejected(client, accounts, change):
    client.app.state.settings.market_data_base_url = "https://market.test"
    # Encode infinity manually: provider JSON is untrusted even when technically non-standard.
    import json

    provider(
        client, lambda request: httpx.Response(200, text=json.dumps({**quote_data(), **change}))
    )
    result = client.get(
        "/v1/market/quote", params={"symbol": "AAPL"}, headers=accounts["alice"]["headers"]
    )
    assert result.status_code == 502 and result.json()["error"]["code"] == "INVALID_MARKET_RESPONSE"


@pytest.mark.parametrize("kind", ["bounds", "order", "future", "range"])
def test_invalid_candles_are_rejected(client, accounts, kind):
    client.app.state.settings.market_data_base_url = "https://market.test"
    data = candle_data()
    if kind == "bounds":
        data["candles"][0]["high"] = 100
    elif kind == "order":
        data["candles"].append(data["candles"][0])
    elif kind == "future":
        data["candles"][0]["at"] = "2027-01-01T00:00:00Z"
    else:
        data["range"] = "month"
    provider(client, lambda request: httpx.Response(200, json=data))
    result = client.get(
        "/v1/market/candles", params={"symbol": "AAPL"}, headers=accounts["alice"]["headers"]
    )
    assert result.status_code == 502


def test_provider_redirect_and_oversized_body_are_rejected(client, accounts):
    client.app.state.settings.market_data_base_url = "https://market.test"
    h = accounts["alice"]["headers"]
    provider(
        client, lambda request: httpx.Response(302, headers={"Location": "https://other.test"})
    )
    assert client.get("/v1/market/quote?symbol=AAPL", headers=h).status_code == 502
    provider(client, lambda request: httpx.Response(200, content=b" " * 2_000_001))
    assert client.get("/v1/market/quote?symbol=AAPL", headers=h).status_code == 502
