import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest

from mori.auth.models import User
from mori.features.models import Feature
from mori.integrations import router as integration_router
from mori.integrations import service as integration_service
from mori.integrations.models import NewsBriefing
from mori.organizer.schemas import Revision


class Clock:
    now_value = datetime.now(UTC)

    @classmethod
    def now(cls, zone=None):
        return cls.now_value if zone is None else cls.now_value.astimezone(zone)


def setup_news(client, accounts):
    client.app.state.settings.searxng_base_url = "http://search.test"
    headers = accounts["alice"]["headers"]
    created = client.put(
        "/v1/news/settings",
        headers=headers,
        json={"topic": "과학", "time": "09:00", "revision": 0},
    )
    assert created.status_code == 200
    client.app.dependency_overrides[integration_router.get_integration_transport] = lambda: (
        httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "title": "이전 기사",
                            "content": "이전 근거",
                            "url": "https://news.test/old",
                        }
                    ]
                },
            )
        )
    )
    assert client.post("/v1/news/refresh", headers=headers, json={"revision": 1}).status_code == 200
    return headers, UUID(created.json()["feature_id"])


def test_abandoned_manual_refresh_recovers_after_deadline_and_keeps_last_briefing(
    client,
    accounts,
    sessions,
    monkeypatch,
):
    headers, feature_id = setup_news(client, accounts)
    previous = client.get("/v1/news", headers=headers).json()
    Clock.now_value = datetime.now(UTC)
    monkeypatch.setattr(integration_router, "datetime", Clock)
    monkeypatch.setattr(integration_service, "datetime", Clock)

    async def interrupted(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(integration_router, "fetch_articles", interrupted)
    with sessions() as session, pytest.raises(asyncio.CancelledError):
        asyncio.run(
            integration_router.refresh_news(
                Revision(revision=1),
                session.get(User, accounts["alice"]["user_id"]),
                session,
                SimpleNamespace(app=client.app),
                None,
            )
        )
    pending = client.get("/v1/news", headers=headers).json()
    assert pending["status"] == "loading"
    assert pending["result_is_stale"]
    Clock.now_value += timedelta(seconds=181)
    assert client.get("/v1/news", headers=accounts["bob"]["headers"]).json()["status"] == "empty"
    with sessions() as session:
        assert session.get(NewsBriefing, feature_id).status == "loading"
    recovered = client.get("/v1/news", headers=headers).json()
    assert recovered["status"] == "failed"
    assert recovered["error_code"] == "NEWS_REFRESH_INTERRUPTED"
    assert recovered["articles"] == previous["articles"]
    assert recovered["collected_at"] == previous["collected_at"]
    assert recovered["result_is_stale"]
    with sessions() as session:
        assert session.get(NewsBriefing, feature_id).status == "failed"
    assert client.get("/v1/news", headers=accounts["bob"]["headers"]).json()["status"] == "empty"


def new_articles():
    from uuid import uuid4

    from mori.integrations.schemas import NewsArticle

    return [
        NewsArticle(
            id=uuid4(),
            title="새 기사",
            summary="새 근거",
            url="https://news.test/new",
            source="news.test",
        )
    ]


def freeze_clock(monkeypatch):
    Clock.now_value = datetime.now(UTC)
    monkeypatch.setattr(integration_router, "datetime", Clock)
    monkeypatch.setattr(integration_service, "datetime", Clock)


def test_expired_fetch_cannot_publish_without_a_prior_read_and_retry_succeeds(
    client,
    accounts,
    sessions,
    monkeypatch,
):
    headers, feature_id = setup_news(client, accounts)
    previous = client.get("/v1/news", headers=headers).json()
    freeze_clock(monkeypatch)

    async def late_fetch(*args, **kwargs):
        Clock.now_value += timedelta(seconds=181)
        return new_articles()

    monkeypatch.setattr(integration_router, "fetch_articles", late_fetch)
    response = client.post("/v1/news/refresh", headers=headers, json={"revision": 1})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "NEWS_REFRESH_SUPERSEDED"
    recovered = client.get("/v1/news", headers=headers).json()
    assert recovered["status"] == "failed"
    assert recovered["error_code"] == "NEWS_REFRESH_INTERRUPTED"
    assert recovered["articles"] == previous["articles"]
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        generation = row.generation
        assert row.manual_refresh_deadline is None
    assert client.get("/v1/news", headers=headers).json()["status"] == "failed"
    with sessions() as session:
        assert session.get(NewsBriefing, feature_id).generation == generation

    async def immediate_fetch(*args, **kwargs):
        return new_articles()

    monkeypatch.setattr(integration_router, "fetch_articles", immediate_fetch)
    retry = client.post("/v1/news/refresh", headers=headers, json={"revision": 1})
    assert retry.status_code == 200
    assert retry.json()["status"] == "ready"
    assert retry.json()["error_code"] is None
    assert retry.json()["articles"][0]["title"] == "새 기사"
    with sessions() as session:
        assert session.get(NewsBriefing, feature_id).manual_refresh_deadline is None


@pytest.mark.parametrize("prior_summary", [False, True])
def test_expired_summary_preserves_the_published_bundle(
    client,
    accounts,
    sessions,
    monkeypatch,
    prior_summary,
):
    from mori.integrations.news import Summary

    headers, feature_id = setup_news(client, accounts)
    if prior_summary:
        with sessions.begin() as session:
            row = session.get(NewsBriefing, feature_id)
            row.summary_text = "이전 요약"
            row.summary_kind = "ai_search_excerpt_summary"
    previous = client.get("/v1/news", headers=headers).json()
    client.app.state.settings.news_summary_enabled = True
    freeze_clock(monkeypatch)

    async def fetch(*args, **kwargs):
        return new_articles()

    async def late_summary(*args, **kwargs):
        with sessions() as session:
            row = session.get(NewsBriefing, feature_id)
            assert row.status == "loading"
            assert row.manual_refresh_deadline is not None
            assert row.articles[0]["title"] == ("이전 기사" if prior_summary else "새 기사")
        Clock.now_value += timedelta(seconds=181)
        return Summary(text="너무 늦은 요약", kind="ai_search_excerpt_summary")

    monkeypatch.setattr(integration_router, "fetch_articles", fetch)
    monkeypatch.setattr(integration_router, "summarize_articles", late_summary)
    response = client.post("/v1/news/refresh", headers=headers, json={"revision": 1})
    assert response.status_code == 409
    state = client.get("/v1/news", headers=headers).json()
    assert state["status"] == "failed"
    assert state["error_code"] == "NEWS_REFRESH_INTERRUPTED"
    assert state["summary_text"] == previous["summary_text"]
    assert "너무 늦은 요약" not in str(state)
    if prior_summary:
        assert state["articles"] == previous["articles"]
        assert state["collected_at"] == previous["collected_at"]
    else:
        assert state["articles"][0]["title"] == "새 기사"
    assert state["result_is_stale"]


def test_summary_cancellation_recovers_while_preserving_previous_sources(
    client,
    accounts,
    sessions,
    monkeypatch,
):
    headers, feature_id = setup_news(client, accounts)
    with sessions.begin() as session:
        row = session.get(NewsBriefing, feature_id)
        row.summary_text = "이전 요약"
        row.summary_kind = "ai_search_excerpt_summary"
    previous = client.get("/v1/news", headers=headers).json()
    client.app.state.settings.news_summary_enabled = True
    freeze_clock(monkeypatch)

    async def fetch(*args, **kwargs):
        return new_articles()

    async def interrupted_summary(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(integration_router, "fetch_articles", fetch)
    monkeypatch.setattr(integration_router, "summarize_articles", interrupted_summary)
    with sessions() as session, pytest.raises(asyncio.CancelledError):
        asyncio.run(
            integration_router.refresh_news(
                Revision(revision=1),
                session.get(User, accounts["alice"]["user_id"]),
                session,
                SimpleNamespace(app=client.app),
                None,
            )
        )
    Clock.now_value += timedelta(seconds=181)
    state = client.get("/v1/news", headers=headers).json()
    assert state["status"] == "failed" and state["error_code"] == "NEWS_REFRESH_INTERRUPTED"
    assert state["articles"] == previous["articles"]
    assert state["summary_text"] == previous["summary_text"]
    assert state["collected_at"] == previous["collected_at"]


def test_scheduled_refresh_replaces_manual_deadline_and_keeps_its_own_recovery(
    client,
    accounts,
    sessions,
    monkeypatch,
):
    from mori.integrations.news import begin_briefing

    headers, feature_id = setup_news(client, accounts)
    freeze_clock(monkeypatch)
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id)
        row = session.get(NewsBriefing, feature_id)
        row.status = "loading"
        row.manual_refresh_deadline = Clock.now_value - timedelta(seconds=1)
        old_generation = row.generation
        begin_briefing(session, feature)
        assert row.generation == old_generation + 1
        assert row.manual_refresh_deadline is None
    Clock.now_value += timedelta(seconds=181)
    state = client.get("/v1/news", headers=headers).json()
    assert state["status"] == "loading"
    assert state["error_code"] is None


@pytest.mark.parametrize("same_generation", [True, False])
def test_migration_recovers_legacy_manual_loading_but_preserves_scheduled_generation(
    client,
    accounts,
    sessions,
    same_generation,
):
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from mori.automation.models import AutomationJob
    from mori.integrations.news import begin_briefing

    headers, feature_id = setup_news(client, accounts)
    now = datetime.now(UTC)
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id)
        row = begin_briefing(session, feature)
        session.add(
            AutomationJob(
                user_id=accounts["alice"]["user_id"],
                feature_id=feature_id,
                scheduled_at=now,
                feature_revision=feature.revision,
                feature_snapshot={},
                status="running",
                available_at=now,
                news_generation=row.generation if same_generation else row.generation - 1,
            )
        )
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.downgrade(config, "0016_reminder_started_at")
    try:
        with sessions() as session:
            assert (
                session.scalar(
                    text("SELECT status FROM news_briefings WHERE feature_id = :id"),
                    {"id": feature_id},
                )
                == "loading"
            )
    finally:
        command.upgrade(config, "head")
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert (row.manual_refresh_deadline is None) is same_generation
    state = client.get("/v1/news", headers=headers).json()
    assert state["status"] == ("loading" if same_generation else "failed")
    assert state["error_code"] == (None if same_generation else "NEWS_REFRESH_INTERRUPTED")
