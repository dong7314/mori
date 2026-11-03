from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import select
from test_automation import create_scheduled_feature, make_stock

from mori.automation.models import AutomationJob
from mori.automation.scheduler import claim_job, complete_job, enqueue_due
from mori.chat import jobs, store
from mori.chat.integrations import PreparedIntegration
from mori.chat.models import ChatTurn, Conversation
from mori.chat.schemas import Decision
from mori.features.models import FeatureResult
from mori.integrations.models import MarketWatch
from mori.integrations.schemas import QuoteRead


def quote(at, *, price=10000, observed_at=None):
    return QuoteRead(
        symbol="ABC",
        currency="KRW",
        price=price,
        previous_close=9000,
        as_of=at,
        observed_at=observed_at,
        provider="test",
        change=1000,
        change_percent=11.11,
    )


def test_late_older_stock_response_keeps_newer_snapshot(sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(
        sessions, accounts, now - timedelta(days=1), repeat="daily"
    )
    make_stock(sessions, feature_id)
    assert enqueue_due(sessions, now=now) == 2
    first = claim_job(sessions, now=now)
    second = claim_job(sessions, now=now)
    with sessions() as session:
        revision = session.scalar(select(MarketWatch.revision))
    older = quote(now - timedelta(seconds=30))
    newer = quote(now, price=11000)
    assert complete_job(sessions, second, quote=newer, watch_revision=revision, now=now)
    assert complete_job(
        sessions,
        first,
        quote=older,
        watch_revision=revision,
        now=now + timedelta(seconds=1),
    )
    with sessions() as session:
        watch = session.scalar(select(MarketWatch))
        assert watch.snapshot["price"] == 11000
        assert datetime.fromisoformat(watch.snapshot["as_of"]) == now
        assert watch.collected_at == now
        assert session.get(AutomationJob, first.id).status == "completed"
        assert session.get(AutomationJob, second.id).status == "completed"
        result = session.scalar(select(FeatureResult).where(FeatureResult.run_id == first.run_id))
        assert "10000 KRW" in result.text
        assert session.get(ChatTurn, first.run_id).status == "completed"


def test_late_chat_market_response_preserves_newer_scheduled_snapshot(sessions, accounts, settings):
    now = datetime.now(UTC)
    user_id = accounts["alice"]["user_id"]
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_stock(sessions, feature_id)
    assert enqueue_due(sessions, now=now) == 1
    scheduled = claim_job(sessions, now=now)
    with sessions.begin() as session:
        revision = session.scalar(select(MarketWatch.revision))
        conversation = Conversation(user_id=user_id, title="시세 확인")
        session.add(conversation)
        session.flush()
        conversation_id = conversation.id
    run_id, _, _ = store.claim(
        sessions,
        user_id,
        conversation_id,
        uuid4(),
        "지금 주가 확인",
        settings.hermes_timeout_seconds,
        durable=True,
    )
    manual = jobs.claim_next(sessions, settings)
    older = quote(now - timedelta(seconds=30))
    newer = quote(now, price=11000)
    assert complete_job(sessions, scheduled, quote=newer, watch_revision=revision, now=now)
    settings.chat_enabled = True
    settings.hermes_test_user_id = user_id
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("test-key")
    decision = Decision(action="market_lookup", market={"revision": revision, "symbol": "ABC"})
    store.finish(
        sessions,
        run_id,
        user_id,
        decision,
        lease_token=manual.token,
        settings=settings,
        runtime_url=settings.hermes_base_url,
        prepared=PreparedIntegration(action="market_lookup", quote=older),
    )
    with sessions() as session:
        watch = session.scalar(select(MarketWatch))
        assert watch.snapshot["price"] == 11000
        assert watch.collected_at == now
        turn = session.get(ChatTurn, run_id)
        assert turn.status == "completed"
        assert "10,000.00 KRW" in turn.answer
        action = next(e for e in turn.events if e["type"] == "action.completed")
        assert action["result"]["price"] == 10000
        assert datetime.fromisoformat(action["result"]["as_of"]) == older.as_of


@pytest.mark.parametrize(
    (
        "candidate_as_of_offset",
        "current_observed_offset",
        "candidate_observed_offset",
        "expected_price",
    ),
    [
        (
            30,
            60,
            30,
            10000,
        ),  # Provider time wins even when the older quote was observed later.
        (
            0,
            60,
            30,
            11000,
        ),  # Same provider time, but the candidate observation is older.
        (0, 30, 60, 10000),
        (0, 30, 30, 10000),  # Exact ties retain the existing completion-order behavior.
        (0, None, 30, 10000),
        (0, 30, None, 10000),
        (0, None, None, 10000),
    ],
)
def test_stock_snapshot_provider_and_observation_time_order(
    sessions,
    accounts,
    candidate_as_of_offset,
    current_observed_offset,
    candidate_observed_offset,
    expected_price,
):
    now = datetime.now(UTC)
    base = now - timedelta(minutes=5)
    feature_id = create_scheduled_feature(
        sessions, accounts, now - timedelta(days=1), repeat="daily"
    )
    make_stock(sessions, feature_id)
    assert enqueue_due(sessions, now=now) == 2
    first = claim_job(sessions, now=now)
    second = claim_job(sessions, now=now)
    with sessions() as session:
        revision = session.scalar(select(MarketWatch.revision))
    current = quote(
        base,
        price=11000,
        observed_at=base + timedelta(seconds=current_observed_offset)
        if current_observed_offset is not None
        else None,
    )
    candidate = quote(
        base + timedelta(seconds=candidate_as_of_offset),
        observed_at=base + timedelta(seconds=candidate_observed_offset)
        if candidate_observed_offset is not None
        else None,
    )
    assert complete_job(sessions, second, quote=current, watch_revision=revision, now=now)
    completed_at = now + timedelta(seconds=1)
    assert complete_job(sessions, first, quote=candidate, watch_revision=revision, now=completed_at)
    with sessions() as session:
        watch = session.scalar(select(MarketWatch))
        assert watch.snapshot["price"] == expected_price
        assert watch.collected_at == (now if expected_price == 11000 else completed_at)
        assert session.get(AutomationJob, first.id).status == "completed"
        assert session.get(AutomationJob, second.id).status == "completed"
        assert session.scalar(
            select(FeatureResult).where(FeatureResult.run_id == first.run_id)
        ).text.startswith("ABC: 10000 KRW")
