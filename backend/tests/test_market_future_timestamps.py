import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from test_chat import SECRET
from test_chat_integrations import Providers, run

from mori.errors import ApiError
from mori.integrations import market
from mori.integrations.models import MarketWatch
from mori.integrations.schemas import QuoteRead
from mori.integrations.service import store_market_snapshot


@pytest.fixture
def providers(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = settings.chat_worker_enabled = True
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.market_data_base_url = "http://market.test"
    return Providers()


class Quotes(Providers):
    def __init__(self, agent, payload):
        super().__init__()
        self.agent = agent
        self.payload = payload

    def __call__(self, request):
        if request.url.host == "market.test":
            self.calls.append(request)
            return httpx.Response(200, json=self.payload)
        return super().__call__(request)


def quote_payload(at, *, price=72400):
    return {
        "symbol": "005930",
        "currency": "KRW",
        "price": price,
        "previous_close": 71000,
        "as_of": at.isoformat(),
        "observed_at": at.isoformat(),
    }


@pytest.mark.parametrize("future_field", ["as_of", "observed_at"])
def test_future_provider_quote_cannot_pin_snapshot_across_chat_runs(
    client, accounts, providers, future_field
):
    now = datetime.now(UTC)
    first_payload = quote_payload(now, price=80000)
    first_payload[future_field] = (now + timedelta(days=2)).isoformat()
    source = Quotes(providers.agent, first_payload)
    decision = {
        "action": "market_lookup",
        "market": {"revision": 0, "symbol": "005930"},
    }
    first, _, cid = run(client, accounts, source, decision)
    watch = client.get("/v1/market/settings", headers=accounts["alice"]["headers"]).json()
    source.payload = quote_payload(now)
    second, _, _ = run(
        client,
        accounts,
        source,
        {
            "action": "market_lookup",
            "market": {"revision": watch["revision"], "symbol": "005930"},
        },
        cid=cid,
    )
    snapshot = client.get("/v1/market/snapshot", headers=accounts["alice"]["headers"]).json()
    assert second["status"] == "completed", second
    assert snapshot["price"] == 72400, {"first": first["status"], "snapshot": snapshot}
    assert first["status"] == "failed", first
    assert first["events"][-1]["code"] == "INVALID_MARKET_RESPONSE"
    assert len(source.calls) == 2


@pytest.mark.parametrize("future_field", ["as_of", "observed_at"])
def test_normal_chat_quote_recovers_existing_future_snapshot(
    client, accounts, providers, sessions, future_field
):
    now = datetime.now(UTC)
    h = accounts["alice"]["headers"]
    watch = client.put(
        "/v1/market/settings", headers=h, json={"revision": 0, "symbol": "005930"}
    ).json()
    poisoned = quote_payload(now, price=80000)
    poisoned[future_field] = (now + timedelta(days=2)).isoformat()
    poisoned.update(provider="test", change=9000, change_percent=12.67)
    with sessions.begin() as session:
        row = session.scalar(
            select(MarketWatch).where(MarketWatch.user_id == accounts["alice"]["user_id"])
        )
        row.snapshot = poisoned
        row.collected_at = now
    source = Quotes(providers.agent, quote_payload(now))
    result, _, _ = run(
        client,
        accounts,
        source,
        {
            "action": "market_lookup",
            "market": {"revision": watch["revision"], "symbol": "005930"},
        },
    )
    assert result["status"] == "completed", result
    assert client.get("/v1/market/snapshot", headers=h).json()["price"] == 72400


@pytest.mark.parametrize("range", [None, "day"])
@pytest.mark.parametrize("future_field", ["as_of", "observed_at"])
@pytest.mark.parametrize("offset_us, accepted", [(300_000_000, True), (300_000_001, False)])
def test_generic_market_clock_skew_boundary(
    settings, monkeypatch, range, future_field, offset_us, accepted
):
    now = datetime(2026, 11, 3, 3, tzinfo=UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(market, "datetime", Clock, raising=False)
    settings.market_data_base_url = "http://market.test"
    payload = quote_payload(now)
    payload[future_field] = (now + timedelta(microseconds=offset_us)).isoformat()
    if range:
        payload.pop("price")
        payload.pop("previous_close")
        payload.update(range=range, candles=[])
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    if accepted:
        assert asyncio.run(
            market.fetch_market(settings, "005930", range=range, transport=transport)
        )
    else:
        with pytest.raises(ApiError) as error:
            asyncio.run(market.fetch_market(settings, "005930", range=range, transport=transport))
        assert error.value.code == "INVALID_MARKET_RESPONSE"


@pytest.mark.parametrize("future_field", ["as_of", "observed_at"])
@pytest.mark.parametrize("offset_us, replaced", [(300_000_000, False), (300_000_001, True)])
def test_snapshot_recovery_preserves_valid_clock_skew_order(future_field, offset_us, replaced):
    now = datetime(2026, 11, 3, 3, tzinfo=UTC)
    current = quote_payload(now, price=80000)
    current[future_field] = (now + timedelta(microseconds=offset_us)).isoformat()
    watch = SimpleNamespace(snapshot=current, collected_at=now)
    candidate = QuoteRead(**quote_payload(now), provider="test", change=1400, change_percent=1.97)
    # Detect invalidity against the original server collection time, even after time has passed.
    assert store_market_snapshot(watch, candidate, now + timedelta(days=3)) is replaced
    assert watch.snapshot["price"] == (72400 if replaced else 80000)


def test_future_observation_keeps_valid_provider_time_order():
    now = datetime(2026, 11, 3, 3, tzinfo=UTC)
    current = quote_payload(now, price=80000)
    current["observed_at"] = (now + timedelta(days=2)).isoformat()
    watch = SimpleNamespace(snapshot=current, collected_at=now)
    candidate = QuoteRead(
        **quote_payload(now - timedelta(minutes=1)),
        provider="test",
        change=1400,
        change_percent=1.97,
    )
    assert not store_market_snapshot(watch, candidate, now + timedelta(seconds=1))
    assert watch.snapshot == current
    assert watch.collected_at == now
