"""PostgreSQL-backed occurrences, fenced leases, and atomic publication of real results.

An expired worker can repeat read-only Hermes/provider calls. A lease token fences
publication, so an occurrence has exactly one persisted result. Schedule cursors
survive downtime; edits/resume start from the feature's new updated_at, without
replaying requests that belonged to a paused or replaced definition.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert

from mori.auth.models import User
from mori.automation.models import AutomationJob, AutomationScheduleState
from mori.chat import store
from mori.chat.context import execution_context
from mori.chat.hermes import interpret
from mori.chat.models import ChatTurn, Conversation
from mori.chat.runtime import resolve_runtime
from mori.chat.schemas import Decision
from mori.errors import ApiError
from mori.features.models import Feature
from mori.features.schemas import Schedule
from mori.features.service import create_feature_result
from mori.features.service import snapshot as feature_snapshot

logger = logging.getLogger(__name__)


def next_occurrence(schedule: dict, not_before: datetime) -> datetime | None:
    """First real local wall-clock occurrence at/after an aware instant.

    Spring-forward gaps are skipped, and a fall-back wall time executes once at its
    first offset. The queue's UTC uniqueness also survives a worker restart in a fold.
    """
    if not_before.tzinfo is None:
        raise ValueError("Scheduling requires a timezone-aware instant")
    value = Schedule.model_validate(schedule)
    if value.repeat == "once" and value.date is None:
        raise ValueError("Stored one-off schedules require an explicit date")
    zone = ZoneInfo(value.timezone)
    start = not_before.astimezone(zone).date()
    for offset in range(370):
        day = value.date if value.repeat == "once" else start + timedelta(days=offset)
        if value.repeat == "weekdays" and day.weekday() >= 5:
            continue
        wall = datetime.combine(day, time.fromisoformat(value.time), tzinfo=zone)
        instant = wall.astimezone(UTC)
        # Attaching tzinfo alone accepts non-existent local times during a DST gap.
        if instant.astimezone(zone).replace(tzinfo=None) != wall.replace(tzinfo=None):
            if value.repeat == "once":
                return None
            continue
        if instant >= not_before:
            return instant
        if value.repeat == "once":
            return None
    raise ValueError("Could not resolve the next occurrence")


def enqueue_due(factory, *, now=None, limit=100):
    """Atomically advance durable cursors and insert up to limit due occurrences."""
    now = now or datetime.now(UTC)
    count = 0
    with factory.begin() as session:
        features = session.scalars(
            select(Feature)
            .outerjoin(AutomationScheduleState, AutomationScheduleState.feature_id == Feature.id)
            .where(
                Feature.deleted_at.is_(None),
                Feature.status == "active",
                Feature.schedule["time"].astext.is_not(None),
                or_(
                    AutomationScheduleState.feature_id.is_(None),
                    AutomationScheduleState.feature_revision != Feature.revision,
                    AutomationScheduleState.next_at <= now,
                ),
            )
            .order_by(Feature.id)
            .limit(limit)
            .with_for_update(of=Feature, skip_locked=True)
        )
        for feature in features:
            state = session.get(AutomationScheduleState, feature.id)
            if state is None:
                state = AutomationScheduleState(feature_id=feature.id, feature_revision=0)
                session.add(state)
            if state.feature_revision != feature.revision:
                state.feature_revision = feature.revision
                state.next_at = next_occurrence(feature.schedule, feature.updated_at)
            while state.next_at is not None and state.next_at <= now and count < limit:
                instant = state.next_at
                session.execute(
                    insert(AutomationJob)
                    .values(
                        id=uuid4(),
                        user_id=feature.user_id,
                        feature_id=feature.id,
                        feature_revision=feature.revision,
                        feature_snapshot=feature_snapshot(feature),
                        scheduled_at=instant,
                        available_at=instant,
                        status="pending",
                        attempts=0,
                    )
                    .on_conflict_do_nothing(constraint="uq_automation_occurrence")
                )
                state.next_at = next_occurrence(
                    feature.schedule, instant + timedelta(microseconds=1)
                )
                count += 1
            if count >= limit:
                break
    return count


@dataclass(frozen=True)
class JobClaim:
    id: UUID
    lease_token: UUID
    user_id: UUID
    feature_id: UUID
    run_id: UUID
    feature_snapshot: dict
    scheduled_at: datetime


def _close_turn(session, job, code, *, cancelled=False):
    if job.run_id:
        turn = session.get(ChatTurn, job.run_id, with_for_update=True)
        if turn is not None and turn.status == "running":
            turn.status = "interrupted" if cancelled else "failed"
            store.append(
                turn, "run." + turn.status, code=code, message="예약 실행을 마치지 못했어요."
            )
    if job.news_generation is not None:
        from mori.integrations.models import NewsBriefing

        row = session.get(NewsBriefing, job.feature_id)
        if row is not None and row.generation == job.news_generation and row.status == "loading":
            row.status, row.error_code = "failed", code


def _cancel(session, job, now, code):
    job.status = "cancelled"
    job.error_code = code
    job.completed_at = now
    job.lease_token = job.lease_until = None
    _close_turn(session, job, code, cancelled=True)


def _active_feature(session, job):
    feature = session.get(Feature, job.feature_id, with_for_update=True)
    return (
        feature
        if feature is not None
        and feature.deleted_at is None
        and feature.status == "active"
        and feature.schedule is not None
        and feature.revision == job.feature_revision
        else None
    )


def claim_job(factory, *, now=None, lease_seconds=900, max_attempts=3):
    """SKIP LOCKED allows competing workers; expired leases are reclaimable."""
    now = now or datetime.now(UTC)
    with factory.begin() as session:
        for _ in range(100):
            job = session.scalar(
                select(AutomationJob)
                .where(
                    or_(
                        (AutomationJob.status == "pending") & (AutomationJob.available_at <= now),
                        (AutomationJob.status == "running") & (AutomationJob.lease_until <= now),
                    )
                )
                .order_by(AutomationJob.available_at, AutomationJob.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            if job is None:
                return None
            feature = _active_feature(session, job)
            if feature is None:
                _cancel(session, job, now, "FEATURE_CHANGED_OR_PAUSED")
                session.flush()
                continue
            if job.attempts >= max_attempts:
                job.status = "failed"
                job.error_code = "AUTOMATION_ATTEMPTS_EXHAUSTED"
                job.completed_at = now
                job.lease_token = job.lease_until = None
                _close_turn(session, job, job.error_code)
                session.flush()
                continue
            job.status = "running"
            job.attempts += 1
            job.lease_token = uuid4()
            job.lease_until = now + timedelta(seconds=lease_seconds)
            if job.run_id is None:
                conversation = Conversation(user_id=job.user_id, title=feature.title)
                session.add(conversation)
                session.flush()
                turn = ChatTurn(
                    conversation_id=conversation.id,
                    request_key=job.id,
                    requested_feature_id=feature.id,
                    feature_id=feature.id,
                    feature_snapshot=job.feature_snapshot,
                    message=f"예약한 기능을 실행해 주세요. ({job.scheduled_at.isoformat()})",
                    status="running",
                    events=[],
                    deadline=job.lease_until,
                )
                session.add(turn)
                session.flush()
                job.run_id = turn.id
            else:
                turn = session.get(ChatTurn, job.run_id, with_for_update=True)
                turn.status = "running"
                turn.deadline = job.lease_until
            store.append(turn, "run.accepted", message="예약한 기능을 실행하고 있어요.")
            return JobClaim(
                job.id,
                job.lease_token,
                job.user_id,
                job.feature_id,
                job.run_id,
                job.feature_snapshot,
                job.scheduled_at,
            )
    return None


def _leased(session, claim, now):
    job = session.get(AutomationJob, claim.id, with_for_update=True)
    if (
        job is None
        or job.status != "running"
        or job.lease_token != claim.lease_token
        or job.lease_until <= now
    ):
        return None
    return job


def begin_news_refresh(factory, claim, *, now=None):
    """Share the manual refresh generation fence before starting provider I/O."""
    from mori.integrations.models import NewsBriefing

    now = now or datetime.now(UTC)
    with factory.begin() as session:
        job = _leased(session, claim, now)
        if job is None:
            return None
        feature = _active_feature(session, job)
        if feature is None:
            _cancel(session, job, now, "FEATURE_CHANGED_OR_PAUSED")
            return None
        row = session.get(NewsBriefing, feature.id)
        if row is None:
            row = NewsBriefing(feature_id=feature.id, generation=0, articles=[])
            session.add(row)
        row.generation += 1
        job.news_generation = row.generation
        row.feature_revision = feature.revision
        row.status, row.error_code = "loading", None
        return row.generation


def complete_job(
    factory,
    claim,
    decision=None,
    *,
    articles=None,
    news_generation=None,
    quote=None,
    watch_revision=None,
    now=None,
):
    """Fence the provider response, then commit the result and completed job together."""
    now = now or datetime.now(UTC)
    with factory.begin() as session:
        job = _leased(session, claim, now)
        if job is None:
            return False
        feature = _active_feature(session, job)
        if feature is None:
            _cancel(session, job, now, "FEATURE_CHANGED_OR_PAUSED")
            return False
        turn = session.get(ChatTurn, job.run_id, with_for_update=True)
        if articles is not None:
            from mori.integrations.models import NewsBriefing
            from mori.integrations.news import store_briefing

            row = session.get(NewsBriefing, feature.id)
            if (
                row is None
                or news_generation is None
                or job.news_generation != news_generation
                or row.generation != news_generation
            ):
                _cancel(session, job, now, "NEWS_REFRESH_SUPERSEDED")
                return False
            store_briefing(session, feature, articles, now)
            answer = "뉴스 브리핑을 수집했어요."
        else:
            if quote is not None:
                from mori.integrations.models import MarketWatch

                watch = session.scalar(
                    select(MarketWatch).where(MarketWatch.user_id == job.user_id).with_for_update()
                )
                if (
                    watch is None
                    or watch.symbol != quote.symbol
                    or watch.revision != watch_revision
                ):
                    _cancel(session, job, now, "MARKET_TARGET_CHANGED")
                    return False
                watch.snapshot = quote.model_dump(mode="json")
                watch.collected_at = now
                answer = (
                    f"{quote.symbol}: {quote.price:g} {quote.currency} "
                    f"(시세 기준 {quote.as_of.isoformat()}, 제공자 {quote.provider})"
                )
            else:
                if decision is None or decision.action != "reply" or not decision.reply:
                    raise ApiError(
                        502, "FEATURE_ACTION_NOT_ALLOWED", "기능 실행은 결과 작성만 지원합니다."
                    )
                answer = decision.reply
            result = create_feature_result(
                session,
                user_id=job.user_id,
                feature_id=job.feature_id,
                feature_version=job.feature_snapshot["version"],
                run_id=job.run_id,
                title=job.feature_snapshot["title"],
                text=answer,
            )
            store.append(
                turn,
                "result.saved",
                result_id=str(result.id),
                feature_id=str(job.feature_id),
                detail_url=f"/v1/feature-results/{result.id}",
                result_ref={
                    "resource_id": str(result.id),
                    "kind": "feature_result",
                    "detail_url": f"/v1/feature-results/{result.id}",
                },
            )
        turn.status = "completed"
        turn.answer = answer
        store.append(turn, "message.completed", text=answer)
        store.append(turn, "run.completed")
        job.status = "completed"
        job.completed_at = now
        job.error_code = None
        job.lease_token = job.lease_until = None
        return True


def retry_job(factory, claim, code, *, now=None, max_attempts=3):
    now = now or datetime.now(UTC)
    with factory.begin() as session:
        job = _leased(session, claim, now)
        if job is None:
            return False
        if _active_feature(session, job) is None:
            _cancel(session, job, now, "FEATURE_CHANGED_OR_PAUSED")
            return False
        job.error_code = code
        job.status = "failed" if job.attempts >= max_attempts else "pending"
        job.available_at = now + timedelta(seconds=min(300, 15 * 2 ** (job.attempts - 1)))
        job.completed_at = now if job.status == "failed" else None
        job.lease_token = job.lease_until = None
        _close_turn(session, job, code)
        return True


async def _execute(factory, settings, claim, transport, news_generation=None):
    if claim.feature_snapshot.get("builtin_key") == "news":
        from mori.integrations.news import fetch_articles

        topic = claim.feature_snapshot.get("work") or claim.feature_snapshot["title"]
        articles = await fetch_articles(settings, topic, transport=transport)
        return await asyncio.to_thread(
            complete_job, factory, claim, articles=articles, news_generation=news_generation
        )
    if claim.feature_snapshot.get("builtin_key") == "stock":
        from mori.integrations.market import fetch_market
        from mori.integrations.models import MarketWatch

        with factory() as session:
            watch = session.scalar(select(MarketWatch).where(MarketWatch.user_id == claim.user_id))
            if watch is None:
                raise ApiError(422, "SYMBOL_REQUIRED", "먼저 관심 종목을 선택해 주세요.")
            symbol, revision = watch.symbol, watch.revision
        quote = await fetch_market(settings, symbol, transport=transport)
        return await asyncio.to_thread(
            complete_job, factory, claim, quote=quote, watch_revision=revision
        )
    with factory() as session:
        user = session.get(User, claim.user_id)
        if user is None:
            raise ApiError(404, "USER_NOT_FOUND", "사용자를 찾을 수 없습니다.")
        runtime = resolve_runtime(settings, user.id, user.tier)
    context = await asyncio.to_thread(execution_context, factory, claim.user_id, claim.run_id)
    async with asyncio.timeout(settings.hermes_timeout_seconds):
        async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
            async for value in interpret(
                client,
                runtime,
                settings,
                "선택한 예약 기능의 작업 내용을 실행해 주세요.",
                [],
                context,
            ):
                if isinstance(value, Decision):
                    return await asyncio.to_thread(complete_job, factory, claim, value)
    raise ApiError(502, "INVALID_AGENT_RESPONSE", "실행 결과를 받지 못했습니다.")


async def run_once(factory, settings, *, transport=None, now=None):
    if not settings.automation_enabled:
        return False
    await asyncio.to_thread(enqueue_due, factory, now=now)
    claim = await asyncio.to_thread(
        claim_job,
        factory,
        now=now,
        lease_seconds=max(settings.automation_lease_seconds, settings.hermes_timeout_seconds + 60),
        max_attempts=settings.automation_max_attempts,
    )
    if claim is None:
        return False
    news_generation = None
    try:
        if claim.feature_snapshot.get("builtin_key") == "news":
            news_generation = await asyncio.to_thread(begin_news_refresh, factory, claim)
            if news_generation is None:
                return True
        await _execute(factory, settings, claim, transport, news_generation)
    except asyncio.CancelledError:
        await asyncio.shield(
            asyncio.to_thread(
                retry_job,
                factory,
                claim,
                "WORKER_INTERRUPTED",
                max_attempts=settings.automation_max_attempts,
            )
        )
        raise
    except Exception as exc:
        code = exc.code if isinstance(exc, ApiError) else "AUTOMATION_EXECUTION_FAILED"
        await asyncio.to_thread(
            retry_job,
            factory,
            claim,
            code,
            max_attempts=settings.automation_max_attempts,
        )
    return True


async def run_worker(factory, settings, *, stop=None):
    if not settings.automation_enabled:
        raise ValueError("Enable MORI_AUTOMATION_ENABLED before starting the worker")
    stop = stop or asyncio.Event()
    while not stop.is_set():
        try:
            worked = await run_once(factory, settings)
        except Exception:
            # Avoid credential/body leakage in queue errors; the next cycle recovers leases.
            logger.error("Automation worker cycle failed")
            worked = False
        if worked:
            continue
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.automation_poll_seconds)
        except TimeoutError:
            pass
