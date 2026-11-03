import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from mori.automation.models import AutomationJob
from mori.automation.scheduler import (
    cancel_job,
    claim_job,
    complete_job,
    enqueue_due,
    run_once,
)
from mori.chat.models import ChatTurn
from mori.features.models import Feature, FeatureResult
from mori.integrations.models import MarketWatch
from mori.integrations.schemas import QuoteRead


def scheduled_watch(sessions, accounts, now):
    instant = now.replace(second=0, microsecond=0)
    with sessions.begin() as session:
        feature = Feature(
            user_id=accounts["alice"]["user_id"],
            builtin_key="stock",
            title="관심 주가",
            description="",
            work="관심 종목의 시세 확인",
            reference="",
            icon="chart",
            status="active",
            created_at=instant - timedelta(minutes=1),
            updated_at=instant - timedelta(minutes=1),
            schedule={
                "time": instant.strftime("%H:%M"),
                "timezone": "UTC",
                "repeat": "once",
                "date": instant.date().isoformat(),
            },
        )
        watch = MarketWatch(user_id=feature.user_id, symbol="005930")
        session.add_all([feature, watch])
        session.flush()
        return watch.id


def quote_payload(now):
    return {
        "symbol": "005930",
        "currency": "KRW",
        "price": 72400,
        "previous_close": 71000,
        "as_of": (now - timedelta(days=1)).replace(hour=0, minute=0).isoformat(),
        "price_kind": "close",
        "as_of_precision": "session_date",
        "observed_at": now.isoformat(),
    }


def test_scheduled_stock_opens_owned_latest_snapshot_and_retains_occurrence_result(
    client, sessions, accounts, settings
):
    now = datetime.now(UTC)
    watch_id = scheduled_watch(sessions, accounts, now)
    settings.automation_enabled = True
    settings.market_data_base_url = "http://market.test"
    settings.market_data_provider = "Test exchange"
    payload = quote_payload(now)

    def market(request):
        assert request.url.path == "/quote"
        assert request.url.params["symbol"] == "005930"
        return httpx.Response(200, json=payload)

    assert asyncio.run(run_once(sessions, settings, transport=httpx.MockTransport(market), now=now))
    h = accounts["alice"]["headers"]
    job = client.get("/v1/automation/jobs", headers=h).json()[0]
    assert job["status"] == "completed"
    messages_url = f"/v1/conversations/{job['conversation_id']}/messages"
    message = client.get(messages_url, headers=h).json()[0]
    assert message["status"] == "completed"
    assert len(message["result_refs"]) == 2
    stock, result = message["result_refs"]
    assert stock == {
        "resource_id": str(watch_id),
        "kind": "stock",
        "detail_url": "/v1/market/snapshot",
    }
    assert result["kind"] == "feature_result"
    snapshot = client.get(stock["detail_url"], headers=h).json()
    assert snapshot["symbol"] == "005930" and snapshot["price"] == 72400
    assert snapshot["provider"] == "Test exchange"
    assert snapshot["price_kind"] == "close" and snapshot["as_of_precision"] == "session_date"
    saved_result = client.get(result["detail_url"], headers=h).json()
    assert "005930: 72400 KRW" in saved_result["text"]
    assert payload["as_of"] in saved_result["text"] and "Test exchange" in saved_result["text"]

    # The stock link follows current settings; the occurrence result stays historical.
    with sessions.begin() as session:
        watch = session.get(MarketWatch, watch_id)
        watch.snapshot = {**watch.snapshot, "price": 73000, "change": 2000}
    assert client.get(stock["detail_url"], headers=h).json()["price"] == 73000
    assert client.get(result["detail_url"], headers=h).json() == saved_result

    other = accounts["bob"]["headers"]
    assert client.get(messages_url, headers=other).status_code == 404
    assert client.get(result["detail_url"], headers=other).status_code == 404
    assert client.get(f"/v1/automation/jobs/{job['id']}", headers=other).status_code == 404
    assert client.get(stock["detail_url"], headers=other).json() is None
    assert client.get(stock["detail_url"]).status_code == 401


@pytest.mark.parametrize("interruption", ["cancelled", "lease_expired", "target_changed"])
def test_unpublished_scheduled_stock_never_exposes_a_result_link(
    client, sessions, accounts, interruption
):
    now = datetime.now(UTC)
    watch_id = scheduled_watch(sessions, accounts, now)
    assert enqueue_due(sessions, now=now) == 1
    claim = claim_job(sessions, now=now)
    with sessions.begin() as session:
        if interruption == "cancelled":
            cancel_job(session, accounts["alice"]["user_id"], claim.id, now=now)
        elif interruption == "lease_expired":
            session.get(AutomationJob, claim.id).lease_until = now - timedelta(seconds=1)
        else:
            watch = session.get(MarketWatch, watch_id)
            watch.symbol = "AAPL"
            watch.revision += 1
    quote = QuoteRead(**quote_payload(now), provider="Test exchange", change=1400, change_percent=2)
    assert not complete_job(sessions, claim, quote=quote, watch_revision=1, now=now)
    with sessions() as session:
        turn = session.get(ChatTurn, claim.run_id)
        conversation_id = turn.conversation_id
        assert not any(event.get("result_ref") for event in turn.events)
        assert session.get(MarketWatch, watch_id).snapshot is None
        assert session.scalar(select(FeatureResult)) is None
    messages = client.get(
        f"/v1/conversations/{conversation_id}/messages", headers=accounts["alice"]["headers"]
    ).json()
    assert messages[0]["result_refs"] == []
