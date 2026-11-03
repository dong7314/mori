from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select

from mori.automation.models import AutomationJob
from mori.automation.scheduler import enqueue_due
from mori.features.models import Feature
from mori.features.schemas import FeatureUpdate
from mori.features.service import update_feature
from mori.integrations.models import MarketWatch
from mori.integrations.schemas import MarketSettings, NewsSettings
from mori.integrations.service import save_market_settings, save_news_settings


def save_market(client, accounts, **values):
    return client.put(
        "/v1/market/settings",
        headers=accounts["alice"]["headers"],
        json={"revision": 0, "symbol": "AAPL", **values},
    )


def test_market_schedule_is_persistent_owned_and_enqueued(client, accounts, sessions):
    now = datetime.now(UTC)
    target = (now + timedelta(minutes=5)).replace(second=0, microsecond=0)
    response = save_market(
        client,
        accounts,
        schedule={
            "time": target.strftime("%H:%M"),
            "timezone": "UTC",
            "repeat": "once",
            "date": target.date().isoformat(),
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == saved["feature_revision"] == 1
    assert saved["feature_id"] and saved["schedule"]["timezone"] == "UTC"
    assert client.get("/v1/market/settings", headers=accounts["alice"]["headers"]).json() == saved
    other = client.get("/v1/market/settings", headers=accounts["bob"]["headers"]).json()
    assert other["schedule"] is None and other["feature_id"] is None
    assert enqueue_due(sessions, now=target - timedelta(seconds=1)) == 0
    assert enqueue_due(sessions, now=target) == 1
    with sessions() as session:
        job = session.scalar(select(AutomationJob))
        assert job.user_id == accounts["alice"]["user_id"]
        assert str(job.feature_id) == saved["feature_id"]
        assert job.feature_snapshot["builtin_key"] == "stock"
        assert job.scheduled_at == target


def test_symbol_only_update_preserves_schedule_and_explicit_null_removes_it(client, accounts):
    original = save_market(
        client, accounts, schedule={"time": "18:00", "repeat": "weekdays"}
    ).json()
    changed = save_market(client, accounts, revision=1, symbol="KOSPI").json()
    assert changed["symbol"] == "KOSPI" and changed["revision"] == 2
    assert changed["schedule"] == original["schedule"]
    assert changed["feature_revision"] == original["feature_revision"]
    rejected = save_market(client, accounts, revision=2, symbol="MSFT", schedule=None)
    assert rejected.status_code == 409
    assert client.get("/v1/market/settings", headers=accounts["alice"]["headers"]).json() == changed
    removed = save_market(
        client, accounts, revision=2, symbol="KOSPI", schedule=None, feature_revision=1
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["schedule"] is None
    assert removed.json()["revision"] == 3 and removed.json()["feature_revision"] == 2


def test_separate_feature_edit_conflicts_without_overwriting_symbol(client, accounts, sessions):
    saved = save_market(client, accounts, schedule={"time": "18:00", "repeat": "daily"}).json()
    feature_id = UUID(saved["feature_id"])
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id)
        update_feature(
            session,
            feature.user_id,
            feature.id,
            FeatureUpdate(
                revision=1,
                title=feature.title,
                work=feature.work,
                icon=feature.icon,
                schedule={"time": "19:00", "repeat": "daily"},
            ),
        )
    response = save_market(
        client,
        accounts,
        revision=1,
        symbol="KOSPI",
        feature_revision=1,
        schedule={"time": "20:00", "repeat": "daily"},
    )
    assert response.status_code == 409
    current = client.get("/v1/market/settings", headers=accounts["alice"]["headers"]).json()
    assert current["symbol"] == "AAPL" and current["revision"] == 1
    assert current["schedule"]["time"] == "19:00" and current["feature_revision"] == 2


def test_integration_settings_join_the_callers_atomic_transaction(settings, accounts, sessions):
    with pytest.raises(RuntimeError, match="later action failed"):
        with sessions.begin() as session:
            save_news_settings(
                session,
                accounts["alice"]["user_id"],
                NewsSettings(revision=0, topic="과학", time="09:00"),
            )
            save_market_settings(
                session,
                accounts["alice"]["user_id"],
                MarketSettings(
                    revision=0,
                    symbol="AAPL",
                    schedule={"time": "18:00", "repeat": "daily"},
                ),
                settings,
            )
            raise RuntimeError("later action failed")
    with sessions() as session:
        assert session.scalar(select(Feature)) is None
        assert session.scalar(select(MarketWatch)) is None
