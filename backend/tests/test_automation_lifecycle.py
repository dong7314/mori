import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event, local
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import event, func, select
from test_automation import create_scheduled_feature, reply

from mori.automation.models import AutomationJob
from mori.automation.scheduler import claim_job, complete_job, enqueue_due, retry_job, run_once
from mori.chat import jobs, store
from mori.chat.models import ChatJob, ChatTurn, Conversation
from mori.features.models import Feature, FeatureResult
from mori.integrations.models import NewsBriefing
from mori.integrations.news import begin_briefing, store_briefing
from mori.organizer.models import Note


def test_reading_expired_automation_lease_preserves_run_until_worker_recovers(
    client, sessions, accounts
):
    now = datetime.now(UTC) - timedelta(minutes=1)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now, lease_seconds=10)
    headers = accounts["alice"]["headers"]
    job = client.get(f"/v1/automation/jobs/{claim.id}", headers=headers).json()
    assert job["conversation_id"] and job["events_url"] == job["run_url"] + "/events"
    snapshot = client.get(job["run_url"], headers=headers).json()
    assert snapshot["status"] == "running" and snapshot["durable"]
    assert not any(event["type"] == "run.interrupted" for event in snapshot["events"])
    recovered = claim_job(sessions, now=now + timedelta(seconds=11))
    assert recovered.run_id == claim.run_id
    assert complete_job(sessions, recovered, reply(), now=now + timedelta(seconds=11))
    snapshot = client.get(job["run_url"], headers=headers).json()
    assert snapshot["status"] == "completed"
    assert [event["type"] for event in snapshot["events"]].count("run.accepted") == 1


def test_retry_is_nonterminal_until_attempts_exhausted(client, sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    assert retry_job(sessions, claim, "PROVIDER_UNAVAILABLE", now=now, max_attempts=2)
    headers = accounts["alice"]["headers"]
    job = client.get(f"/v1/automation/jobs/{claim.id}", headers=headers).json()
    assert datetime.fromisoformat(job["next_attempt_at"]) == now + timedelta(seconds=15)
    snapshot = client.get(job["run_url"], headers=headers).json()
    assert snapshot["status"] == "running"
    assert snapshot["events"][-1]["type"] == "run.retrying"
    assert not any(event["type"] == "run.failed" for event in snapshot["events"])
    second = claim_job(sessions, now=now + timedelta(seconds=15), max_attempts=2)
    assert retry_job(
        sessions, second, "PROVIDER_UNAVAILABLE", now=now + timedelta(seconds=15), max_attempts=2
    )
    failed = client.get(job["run_url"], headers=headers).json()
    assert failed["status"] == "failed"
    assert [event["type"] for event in failed["events"]].count("run.failed") == 1


@pytest.mark.parametrize("phase", ["pending", "running", "retry"])
def test_cancel_occurrence_is_owned_idempotent_and_preserves_future_schedule(
    client, sessions, accounts, phase
):
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now, repeat="daily")
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now) if phase != "pending" else None
    if phase == "retry":
        retry_job(sessions, claim, "PROVIDER_UNAVAILABLE", now=now)
    with sessions() as session:
        job_id = session.scalar(select(AutomationJob.id))
    url = f"/v1/automation/jobs/{job_id}"
    headers = accounts["alice"]["headers"]
    assert client.post(url + "/cancel").status_code == 401
    assert client.post(url + "/cancel", headers=accounts["bob"]["headers"]).status_code == 404
    assert client.get(url, headers=accounts["bob"]["headers"]).status_code == 404
    response = client.post(url + "/cancel", headers=headers)
    assert response.status_code == 200, response.text
    cancelled = response.json()
    assert cancelled["status"] == "cancelled" and cancelled["error_code"] == "USER_CANCELLED"
    assert cancelled["next_attempt_at"] is None
    assert client.post(url + "/cancel", headers=headers).json() == cancelled
    if claim:
        assert not complete_job(sessions, claim, reply(), now=now)
        assert not retry_job(sessions, claim, "STALE", now=now)
        snapshot = client.get(cancelled["run_url"], headers=headers).json()
        assert snapshot["status"] == "interrupted"
        assert snapshot["events"][-1]["code"] == "USER_CANCELLED"
    assert claim_job(sessions, now=now + timedelta(minutes=1)) is None
    assert enqueue_due(sessions, now=now + timedelta(days=1)) == 1
    next_claim = claim_job(sessions, now=now + timedelta(days=1))
    assert next_claim is not None and next_claim.id != job_id
    with sessions() as session:
        assert session.get(Feature, feature_id).status == "active"
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_finished_occurrence_cancellation_keeps_success_and_links(client, sessions, accounts):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    assert complete_job(sessions, claim, reply(), now=now)
    headers = accounts["alice"]["headers"]
    job = client.post(f"/v1/automation/jobs/{claim.id}/cancel", headers=headers).json()
    assert job["status"] == "completed" and job["error_code"] is None
    listed = client.get("/v1/automation/jobs", headers=headers).json()[0]
    assert listed == job
    stream = client.get(job["events_url"], headers=headers)
    assert stream.status_code == 200 and "event: run.completed\n" in stream.text


@pytest.mark.parametrize("operation", ["complete", "reclaim"])
def test_terminal_run_cannot_be_resurrected(sessions, accounts, operation):
    now = datetime.now(UTC)
    create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now, lease_seconds=10)
    store.fail(sessions, claim.run_id, "EXPLICIT_FAILURE")
    if operation == "complete":
        assert not complete_job(sessions, claim, reply(), now=now)
    else:
        assert claim_job(sessions, now=now + timedelta(seconds=11)) is None
    with sessions() as session:
        assert session.get(ChatTurn, claim.run_id).status == "failed"
        assert session.get(AutomationJob, claim.id).status == "cancelled"
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_catchup_uses_occurrence_day_and_schedule_timezone(
    sessions, accounts, settings, monkeypatch
):
    from mori.automation import scheduler

    scheduled = datetime(2026, 10, 2, 6, 30, tzinfo=UTC)
    create_scheduled_feature(
        sessions,
        accounts,
        scheduled,
        schedule={
            "time": "23:30",
            "timezone": "America/Los_Angeles",
            "repeat": "once",
            "date": "2026-10-01",
        },
    )
    with sessions.begin() as session:
        session.add_all(
            [
                Note(
                    user_id=accounts["alice"]["user_id"],
                    title="예약한 날의 메모",
                    body="포함",
                    created_at=datetime(2026, 10, 1, 7, 5, tzinfo=UTC),
                    updated_at=datetime(2026, 10, 1, 7, 5, tzinfo=UTC),
                ),
                Note(
                    user_id=accounts["alice"]["user_id"],
                    title="다음 날의 메모",
                    body="제외",
                    created_at=datetime(2026, 10, 2, 7, 5, tzinfo=UTC),
                    updated_at=datetime(2026, 10, 2, 7, 5, tzinfo=UTC),
                ),
            ]
        )
    settings.automation_enabled = settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("automation-test-key")
    observed = []

    async def model(client, runtime, settings, message, history, context):
        observed.append(json.loads(context))
        yield reply()

    monkeypatch.setattr(scheduler, "interpret", model)
    assert asyncio.run(run_once(sessions, settings))
    assert [note["title"] for note in observed[0]["today_notes"]] == ["예약한 날의 메모"]
    with sessions() as session:
        assert session.scalar(select(AutomationJob.status)) == "completed"


@pytest.mark.parametrize("other_operation", ["scheduled_completion", "manual_submission"])
def test_concurrent_feature_operations_do_not_deadlock(
    sessions, accounts, settings, other_operation
):
    """A manual completion can hold User while another feature operation starts."""
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    scheduled = claim_job(sessions, now=now)
    user_id = accounts["alice"]["user_id"]
    settings.chat_enabled = settings.chat_worker_enabled = True
    settings.hermes_test_user_id = user_id
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("concurrency-test-key")
    with sessions.begin() as session:
        conversation = Conversation(user_id=user_id, title="동시 실행")
        session.add(conversation)
        other_conversation = Conversation(user_id=user_id, title="다른 대화")
        session.add(other_conversation)
        session.flush()
        conversation_id = conversation.id
        other_conversation_id = other_conversation.id
    run_id, _, _ = store.claim(
        sessions,
        user_id,
        conversation_id,
        uuid4(),
        "기능 실행",
        settings.hermes_timeout_seconds,
        feature_id,
        durable=True,
    )
    manual = jobs.claim_next(sessions, settings)
    user_locked, scheduled_user_requested = Event(), Event()
    role = local()
    engine = sessions.kw["bind"]

    def before_query(connection, cursor, statement, parameters, context, executemany):
        if getattr(role, "value", None) == "scheduled" and (
            statement.startswith("SELECT")
            and "FROM users" in statement
            and "FOR UPDATE" in statement
            or statement.startswith("INSERT INTO chat_jobs")
        ):
            scheduled_user_requested.set()

    def after_query(connection, cursor, statement, parameters, context, executemany):
        if (
            getattr(role, "value", None) == "manual"
            and statement.startswith("SELECT")
            and "FROM users" in statement
            and "FOR UPDATE" in statement
        ):
            user_locked.set()
            assert scheduled_user_requested.wait(5)

    def finish_manual():
        role.value = "manual"
        return store.finish(
            sessions, run_id, user_id, reply(), lease_token=manual.token, settings=settings
        )

    def finish_scheduled():
        role.value = "scheduled"
        if other_operation == "manual_submission":
            return store.claim(
                sessions,
                user_id,
                other_conversation_id,
                uuid4(),
                "새 기능 실행",
                settings.hermes_timeout_seconds,
                feature_id,
                durable=True,
            )
        return complete_job(sessions, scheduled, reply(), settings=settings)

    event.listen(engine, "before_cursor_execute", before_query)
    event.listen(engine, "after_cursor_execute", after_query)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(finish_manual)
            assert user_locked.wait(5)
            second = pool.submit(finish_scheduled)
            assert first.result(timeout=10)
            other_result = second.result(timeout=10)
            assert other_result
    finally:
        event.remove(engine, "before_cursor_execute", before_query)
        event.remove(engine, "after_cursor_execute", after_query)
    with sessions() as session:
        assert session.get(ChatTurn, run_id).status == "completed"
        if other_operation == "scheduled_completion":
            assert session.get(AutomationJob, scheduled.id).status == "completed"
            expected_results = 2
        else:
            assert session.get(ChatJob, other_result[0]).status == "queued"
            expected_results = 1
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == expected_results


def test_cancelled_news_occurrence_cannot_overwrite_newer_manual_refresh(sessions, accounts):
    from mori.automation.scheduler import begin_news_refresh, cancel_job

    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    enqueue_due(sessions, now=now)
    claim = claim_job(sessions, now=now)
    generation = begin_news_refresh(sessions, claim, now=now)
    cancellation_writing, manual_finished = Event(), Event()
    role = local()
    engine = sessions.kw["bind"]

    def before_query(connection, cursor, statement, parameters, context, executemany):
        if getattr(role, "value", None) == "cancel" and statement.startswith(
            "UPDATE news_briefings"
        ):
            cancellation_writing.set()
            assert manual_finished.wait(5)

    def cancel():
        role.value = "cancel"
        with sessions.begin() as session:
            cancel_job(session, claim.user_id, claim.id, now=now)

    event.listen(engine, "before_cursor_execute", before_query)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            cancelled = pool.submit(cancel)
            assert cancellation_writing.wait(5)
            try:
                with sessions.begin() as session:
                    feature = session.get(Feature, feature_id, with_for_update=True)
                    row = begin_briefing(session, feature)
                    assert row.generation == generation + 1
                    store_briefing(session, feature, [], now)
            finally:
                manual_finished.set()
            cancelled.result(timeout=10)
    finally:
        event.remove(engine, "before_cursor_execute", before_query)
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        assert row.generation == generation + 1
        assert row.status == "ready" and row.error_code is None
        assert session.get(AutomationJob, claim.id).status == "cancelled"


def test_claim_releases_cancelled_occurrence_locks_before_next_user(
    sessions, accounts, monkeypatch
):
    """Workers skipping stale jobs must not retain opposite users' locks."""
    from mori.automation import scheduler

    now = datetime.now(UTC)
    stale_alice = create_scheduled_feature(sessions, accounts, now)
    bob_accounts = {"alice": accounts["bob"]}
    stale_bob = create_scheduled_feature(sessions, bob_accounts, now)
    active_bob = create_scheduled_feature(sessions, bob_accounts, now)
    active_alice = create_scheduled_feature(sessions, accounts, now)
    assert enqueue_due(sessions, now=now) == 4
    order = [stale_alice, stale_bob, active_bob, active_alice]
    with sessions.begin() as session:
        session.get(Feature, stale_alice).status = "paused"
        session.get(Feature, stale_bob).status = "paused"
        for job in session.scalars(select(AutomationJob)):
            job.available_at = now - timedelta(seconds=4 - order.index(job.feature_id))

    alice_locked, bob_locked, next_user_requested = Event(), Event(), Event()
    original = scheduler._active_feature

    def interleave(session, job):
        if job.feature_id == active_bob:
            next_user_requested.set()
        feature = original(session, job)
        if job.feature_id == stale_alice:
            alice_locked.set()
            assert bob_locked.wait(5)
        elif job.feature_id == stale_bob:
            bob_locked.set()
            assert next_user_requested.wait(5)
        return feature

    monkeypatch.setattr(scheduler, "_active_feature", interleave)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(claim_job, sessions, now=now)
        assert alice_locked.wait(5)
        second = pool.submit(claim_job, sessions, now=now)
        claims = [first.result(timeout=10), second.result(timeout=10)]

    assert {claim.feature_id for claim in claims} == {active_alice, active_bob}
    with sessions() as session:
        states = {job.feature_id: job.status for job in session.scalars(select(AutomationJob))}
        assert states == {
            stale_alice: "cancelled",
            stale_bob: "cancelled",
            active_alice: "running",
            active_bob: "running",
        }
