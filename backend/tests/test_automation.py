import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select

from mori.automation.models import AutomationJob, AutomationScheduleState
from mori.automation.scheduler import (
    begin_news_refresh,
    claim_job,
    complete_job,
    enqueue_due,
    next_occurrence,
    retry_job,
    run_once,
)
from mori.chat.models import ChatTurn
from mori.chat.schemas import Decision
from mori.features.models import Feature, FeatureResult
from mori.integrations.models import MarketWatch, NewsBriefing
from mori.integrations.schemas import NewsArticle


@pytest.mark.parametrize(
    ("schedule", "start", "expected"),
    [
        (
            {"time": "09:00", "timezone": "Asia/Seoul", "repeat": "daily"},
            "2026-11-01T00:00:00+00:00",
            "2026-11-01T00:00:00+00:00",
        ),
        (
            {"time": "09:00", "timezone": "Asia/Seoul", "repeat": "daily"},
            "2026-11-01T00:00:01+00:00",
            "2026-11-02T00:00:00+00:00",
        ),
        (
            {"time": "09:00", "timezone": "Asia/Seoul", "repeat": "weekdays"},
            "2026-10-30T00:00:01+00:00",
            "2026-11-02T00:00:00+00:00",
        ),
        (
            {
                "time": "09:00",
                "timezone": "Asia/Seoul",
                "repeat": "once",
                "date": "2026-11-02",
            },
            "2026-11-01T00:00:00+00:00",
            "2026-11-02T00:00:00+00:00",
        ),
        (
            {
                "time": "09:00",
                "timezone": "Asia/Seoul",
                "repeat": "once",
                "date": "2026-11-01",
            },
            "2026-11-01T00:00:01+00:00",
            None,
        ),
        (
            {"time": "02:30", "timezone": "America/New_York", "repeat": "daily"},
            "2026-03-08T00:00:00+00:00",
            "2026-03-09T06:30:00+00:00",
        ),
        (
            {"time": "01:30", "timezone": "America/New_York", "repeat": "daily"},
            "2026-11-01T05:30:01+00:00",
            "2026-11-02T06:30:00+00:00",
        ),
    ],
)
def test_occurrences_use_wall_clock_date_weekdays_and_dst_once(schedule, start, expected):
    result = next_occurrence(schedule, datetime.fromisoformat(start))
    assert result == (datetime.fromisoformat(expected) if expected else None)


def create_scheduled_feature(sessions, accounts, now, *, repeat="once", schedule=None):
    instant = now.replace(second=0, microsecond=0)
    with sessions.begin() as session:
        feature = Feature(
            user_id=accounts["alice"]["user_id"],
            title="아침 정리",
            description="오늘 메모 정리",
            work="오늘 메모를 할 일로 정리해 줘",
            reference="",
            icon="note",
            status="active",
            version=1,
            revision=1,
            created_at=instant - timedelta(minutes=1),
            updated_at=instant - timedelta(minutes=1),
            schedule=schedule
            or {
                "time": instant.strftime("%H:%M"),
                "timezone": "UTC",
                "repeat": repeat,
                "date": instant.date().isoformat() if repeat == "once" else None,
            },
        )
        session.add(feature)
        session.flush()
        return feature.id


def reply():
    return Decision(action="reply", reply="- [ ] 오늘 할 일\n- [x] 완료한 일")


def test_cursor_and_occurrence_survive_repeated_enqueue_and_downtime(sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now, repeat="daily")
    assert enqueue_due(sessions, now=now) == 1
    assert enqueue_due(sessions, now=now) == 0
    assert enqueue_due(sessions, now=now + timedelta(days=3)) == 3
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(AutomationJob)) == 4
        state = session.get(AutomationScheduleState, feature_id)
        assert state.next_at > now + timedelta(days=3)
    # Rebuilding a cursor is safe: the database owns occurrence uniqueness.
    with sessions.begin() as session:
        session.delete(session.get(AutomationScheduleState, feature_id))
    assert enqueue_due(sessions, now=now + timedelta(days=3)) == 4
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(AutomationJob)) == 4


def test_parallel_workers_enqueue_and_claim_each_occurrence_once(sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    create_scheduled_feature(sessions, accounts, now)
    barrier = Barrier(2)

    def enqueue():
        barrier.wait(timeout=5)
        return enqueue_due(sessions, now=now)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(enqueue) for _ in range(2)]
        assert sum(f.result(timeout=10) for f in futures) == 2
    barrier = Barrier(2)

    def claim():
        barrier.wait(timeout=5)
        return claim_job(sessions, now=now)

    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = [f.result(timeout=10) for f in [pool.submit(claim), pool.submit(claim)]]
    assert all(claims)
    assert len({c.id for c in claims}) == 2
    assert claim_job(sessions, now=now) is None
    for claim in claims:
        assert complete_job(sessions, claim, reply(), now=now)
        assert not complete_job(sessions, claim, reply(), now=now)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 2


def test_expired_lease_is_recovered_and_stale_worker_cannot_publish(sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    stale = claim_job(sessions, now=now, lease_seconds=10)
    later = now + timedelta(seconds=11)
    replacement = claim_job(sessions, now=later, lease_seconds=60)
    assert replacement.id == stale.id
    assert replacement.run_id == stale.run_id
    assert replacement.lease_token != stale.lease_token
    assert not complete_job(sessions, stale, reply(), now=later)
    assert not retry_job(sessions, stale, "OLD_WORKER_ERROR", now=later)
    assert complete_job(sessions, replacement, reply(), now=later)
    with sessions() as session:
        job = session.get(AutomationJob, stale.id)
        assert job.status == "completed" and job.attempts == 2
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 1
        assert session.get(ChatTurn, stale.run_id).status == "completed"


def test_pausing_queued_and_inflight_features_cancels_without_results(sessions, accounts):
    now = datetime.now(UTC)
    first = create_scheduled_feature(sessions, accounts, now)
    second = create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    with sessions.begin() as session:
        session.get(Feature, first).status = "paused"
    claim = claim_job(sessions, now=now)
    assert claim.feature_id == second
    with sessions.begin() as session:
        session.get(Feature, second).status = "paused"
    assert not complete_job(sessions, claim, reply(), now=now)
    assert claim_job(sessions, now=now) is None
    with sessions() as session:
        assert set(session.scalars(select(AutomationJob.status))) == {"cancelled"}
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_result_and_completed_job_roll_back_together(sessions, accounts, monkeypatch):
    from mori.automation import scheduler

    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    original = scheduler.create_feature_result

    def broken(session, **kwargs):
        original(session, **kwargs)
        raise RuntimeError("Fail after the result was flushed")

    monkeypatch.setattr(scheduler, "create_feature_result", broken)
    with pytest.raises(RuntimeError):
        complete_job(sessions, claim, reply(), now=now)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0
        assert session.get(AutomationJob, claim.id).status == "running"
        assert session.get(ChatTurn, claim.run_id).status == "running"
    monkeypatch.setattr(scheduler, "create_feature_result", original)
    assert complete_job(sessions, claim, reply(), now=now)


def test_changed_definition_discards_stale_job_and_resume_skips_paused_time(sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now, repeat="daily")
    enqueue_due(sessions, now=now)
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id)
        feature.revision += 1
        feature.updated_at = now + timedelta(days=2)
    assert claim_job(sessions, now=now + timedelta(days=2)) is None
    assert enqueue_due(sessions, now=now + timedelta(days=2)) == 0
    assert enqueue_due(sessions, now=now + timedelta(days=3)) == 1


def test_retries_have_backoff_limit_and_leave_no_false_success(sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    first = claim_job(sessions, now=now, max_attempts=2)
    assert retry_job(sessions, first, "HERMES_UNAVAILABLE", now=now, max_attempts=2)
    assert claim_job(sessions, now=now + timedelta(seconds=14), max_attempts=2) is None
    second = claim_job(sessions, now=now + timedelta(seconds=15), max_attempts=2)
    assert second.run_id == first.run_id
    assert retry_job(
        sessions,
        second,
        "HERMES_UNAVAILABLE",
        now=now + timedelta(seconds=15),
        max_attempts=2,
    )
    assert claim_job(sessions, now=now + timedelta(days=1), max_attempts=2) is None
    with sessions() as session:
        job = session.get(AutomationJob, first.id)
        assert job.status == "failed" and job.attempts == 2
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_final_crashed_attempt_is_failed_on_lease_recovery(sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now, lease_seconds=10, max_attempts=1)
    assert claim_job(sessions, now=now + timedelta(seconds=11), max_attempts=1) is None
    with sessions() as session:
        job = session.get(AutomationJob, claim.id)
        assert job.status == "failed"
        assert job.error_code == "AUTOMATION_ATTEMPTS_EXHAUSTED"


def test_disabled_worker_never_enqueues_or_calls_upstream(sessions, accounts, settings):
    create_scheduled_feature(sessions, accounts, datetime.now(UTC))
    settings.automation_enabled = False

    def unexpected(request):
        pytest.fail("Disabled automation contacted upstream")

    assert not asyncio.run(run_once(sessions, settings, transport=httpx.MockTransport(unexpected)))
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(AutomationJob)) == 0


def test_worker_executes_real_hermes_protocol_and_publishes_once(sessions, accounts, settings):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    settings.automation_enabled = settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("automation-test-key")
    paths = []

    def agent(request):
        paths.append(request.url.path)
        assert request.headers["authorization"] == "Bearer automation-test-key"
        if request.url.path == "/v1/toolsets":
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
        payload = json.loads(request.content)
        assert payload["store"] is False and payload["stream"] is True
        assert "selected_feature" in payload["instructions"]
        event = {
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": reply().model_dump_json()}],
                    }
                ],
            },
        }
        return httpx.Response(
            200,
            text="data: " + json.dumps(event) + "\n\n",
            headers={"Content-Type": "text/event-stream"},
        )

    transport = httpx.MockTransport(agent)
    assert asyncio.run(run_once(sessions, settings, transport=transport, now=now))
    assert not asyncio.run(run_once(sessions, settings, transport=transport, now=now))
    assert paths == ["/v1/toolsets", "/v1/responses"]
    with sessions() as session:
        job = session.scalar(select(AutomationJob))
        assert job.status == "completed"
        result = session.scalar(select(FeatureResult))
        assert result.run_id == job.run_id and result.text == reply().reply
        assert len(result.items) == 2


def test_provider_failure_does_not_create_result(sessions, accounts, settings):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    settings.automation_enabled = settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("automation-test-key")
    assert asyncio.run(
        run_once(
            sessions,
            settings,
            transport=httpx.MockTransport(lambda request: httpx.Response(503)),
            now=now,
        )
    )
    with sessions() as session:
        job = session.scalar(select(AutomationJob))
        assert job.status == "pending" and job.error_code == "HERMES_UNAVAILABLE"
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_jobs_api_scopes_history_to_current_owner(client, sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    response = client.get("/v1/automation/jobs", headers=accounts["alice"]["headers"])
    assert response.status_code == 200
    assert len(response.json()) == 1 and response.json()[0]["feature_id"] == str(feature_id)
    assert "feature_snapshot" not in response.json()[0]
    assert client.get("/v1/automation/jobs", headers=accounts["bob"]["headers"]).json() == []
    assert client.get("/v1/automation/jobs").status_code == 401


def make_news(sessions, feature_id):
    with sessions.begin() as session:
        session.get(Feature, feature_id).builtin_key = "news"


def article(title):
    from uuid import uuid4

    return NewsArticle(
        id=uuid4(),
        title=title,
        summary="검색 발췌",
        url="https://news.test/article",
        source="news.test",
    )


def test_scheduled_news_uses_provider_and_persists_structured_articles(
    sessions, accounts, settings
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    settings.automation_enabled = True
    settings.searxng_base_url = "http://search.test"

    def search(request):
        assert request.url.path == "/search"
        assert request.url.params["categories"] == "news"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "새 기사",
                        "content": "<b>검색 발췌</b>",
                        "url": "https://news.test/article",
                    }
                ]
            },
        )

    assert asyncio.run(run_once(sessions, settings, transport=httpx.MockTransport(search), now=now))
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.status == "ready" and row.generation == 1
        assert row.articles[0]["title"] == "새 기사"
        assert row.articles[0]["summary"] == "검색 발췌"
        assert session.scalar(select(AutomationJob.status)) == "completed"
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_new_manual_news_refresh_fences_older_scheduled_response(sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    generation = begin_news_refresh(sessions, claim, now=now)
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id, with_for_update=True)
        row = session.get(NewsBriefing, feature.id)
        row.generation += 1
        row.status = "ready"
        row.articles = [article("더 나중에 시작한 수동 수집").model_dump(mode="json")]
    assert not complete_job(
        sessions,
        claim,
        articles=[article("늦게 도착한 예약 응답")],
        news_generation=generation,
        now=now,
    )
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.articles[0]["title"] == "더 나중에 시작한 수동 수집"
        assert session.get(AutomationJob, claim.id).error_code == "NEWS_REFRESH_SUPERSEDED"


def test_new_scheduled_news_refresh_fences_older_manual_response(client, sessions, accounts):
    from mori.integrations.router import get_integration_transport

    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    client.app.state.settings.searxng_base_url = "http://search.test"
    started, release = Event(), Event()

    def search(request):
        started.set()
        assert release.wait(timeout=10)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "이전 수동 수집",
                        "content": "발췌",
                        "url": "https://news.test/old",
                    }
                ]
            },
        )

    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(search)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(
            client.post,
            "/v1/news/refresh",
            json={"revision": 1},
            headers=accounts["alice"]["headers"],
        )
        try:
            assert started.wait(timeout=10)
            generation = begin_news_refresh(sessions, claim, now=now)
            assert generation == 2
            assert complete_job(
                sessions,
                claim,
                articles=[article("새 예약 수집")],
                news_generation=generation,
                now=now,
            )
        finally:
            release.set()
        response = pending.result(timeout=10)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "NEWS_REFRESH_SUPERSEDED"
    with sessions() as session:
        assert session.get(NewsBriefing, feature_id).articles[0]["title"] == "새 예약 수집"


def test_failed_scheduled_news_marks_only_its_own_generation(sessions, accounts):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    begin_news_refresh(sessions, claim, now=now)
    assert retry_job(sessions, claim, "PROVIDER_UNAVAILABLE", now=now)
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.status == "failed" and row.error_code == "PROVIDER_UNAVAILABLE"
    replacement = claim_job(sessions, now=now + timedelta(seconds=15))
    begin_news_refresh(sessions, replacement, now=now + timedelta(seconds=15))
    with sessions.begin() as session:
        row = session.get(NewsBriefing, feature_id)
        row.generation += 1
        row.status, row.error_code = "ready", None
    assert retry_job(
        sessions,
        replacement,
        "OLD_PROVIDER_ERROR",
        now=now + timedelta(seconds=15),
    )
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.status == "ready" and row.error_code is None


@pytest.mark.parametrize("newer_refresh", [False, True])
def test_crashed_final_news_attempt_clears_only_its_loading_generation(
    sessions, accounts, newer_refresh
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now, lease_seconds=10, max_attempts=1)
    begin_news_refresh(sessions, claim, now=now)
    if newer_refresh:
        with sessions.begin() as session:
            row = session.get(NewsBriefing, feature_id)
            row.generation += 1
            row.status = "ready"
    assert claim_job(sessions, now=now + timedelta(seconds=11), max_attempts=1) is None
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.status == ("ready" if newer_refresh else "failed")
        if not newer_refresh:
            assert row.error_code == "AUTOMATION_ATTEMPTS_EXHAUSTED"


def make_stock(sessions, feature_id, *, watch=True):
    with sessions.begin() as session:
        feature = session.get(Feature, feature_id)
        feature.builtin_key = "stock"
        if watch:
            session.add(MarketWatch(user_id=feature.user_id, symbol="ABC"))


def quote_payload():
    return {
        "symbol": "ABC",
        "currency": "KRW",
        "price": 12500,
        "previous_close": 12000,
        "as_of": datetime.now(UTC).isoformat(),
    }


def test_scheduled_stock_persists_real_quote_snapshot_and_feature_result(
    sessions, accounts, settings
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_stock(sessions, feature_id)
    settings.automation_enabled = True
    settings.market_data_base_url = "http://market.test"
    payload = quote_payload()

    def market(request):
        assert request.url.path == "/quote" and request.url.params["symbol"] == "ABC"
        return httpx.Response(200, json=payload)

    assert asyncio.run(run_once(sessions, settings, transport=httpx.MockTransport(market), now=now))
    with sessions() as session:
        watch = session.scalar(select(MarketWatch))
        assert watch.snapshot["price"] == 12500 and watch.snapshot["symbol"] == "ABC"
        assert datetime.fromisoformat(watch.snapshot["as_of"]) == datetime.fromisoformat(
            payload["as_of"]
        )
        assert watch.collected_at is not None
        job = session.scalar(select(AutomationJob))
        assert job.status == "completed"
        result = session.scalar(select(FeatureResult))
        assert result.run_id == job.run_id
        assert "ABC: 12500 KRW" in result.text
        assert datetime.fromisoformat(payload["as_of"]).isoformat() in result.text


@pytest.mark.parametrize("missing", ["provider", "symbol"])
def test_scheduled_stock_without_provider_or_symbol_never_succeeds(
    sessions, accounts, settings, missing
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_stock(sessions, feature_id, watch=missing != "symbol")
    settings.automation_enabled = True
    if missing == "symbol":
        settings.market_data_base_url = "http://market.test"

    def unexpected(request):
        pytest.fail("Unconfigured stock job contacted a provider")

    assert asyncio.run(
        run_once(sessions, settings, transport=httpx.MockTransport(unexpected), now=now)
    )
    with sessions() as session:
        job = session.scalar(select(AutomationJob))
        expected = "SYMBOL_REQUIRED" if missing == "symbol" else "MARKET_DATA_NOT_CONFIGURED"
        assert job.status == "pending" and job.error_code == expected
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


@pytest.mark.parametrize("change_back", [False, True])
def test_changing_watched_symbol_during_fetch_fences_old_quote(
    sessions, accounts, settings, change_back
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_stock(sessions, feature_id)
    settings.automation_enabled = True
    settings.market_data_base_url = "http://market.test"

    def market(request):
        with sessions.begin() as session:
            watch = session.scalar(select(MarketWatch).with_for_update())
            watch.symbol = "ABC" if change_back else "DEF"
            watch.revision += 2 if change_back else 1
        return httpx.Response(200, json=quote_payload())

    assert asyncio.run(run_once(sessions, settings, transport=httpx.MockTransport(market), now=now))
    with sessions() as session:
        assert session.scalar(select(AutomationJob.status)) == "cancelled"
        assert session.scalar(select(AutomationJob.error_code)) == "MARKET_TARGET_CHANGED"
        watch = session.scalar(select(MarketWatch))
        assert watch.snapshot is None and watch.collected_at is None
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0
