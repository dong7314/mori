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
from sqlalchemy import or_, select, update
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
    value.validate_utc_range()
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
        due_features = (
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
        )
        # Match manual feature/news writes: User precedes Feature. Inserting an
        # occurrence also takes a User foreign-key lock, so enqueue needs the
        # same order even though it does not change the user itself.
        user_ids = list(
            session.scalars(
                select(User.id)
                .where(due_features.where(Feature.user_id == User.id).exists())
                .order_by(User.id)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        if not user_ids:
            return 0
        features = session.scalars(
            due_features.where(Feature.user_id.in_(user_ids))
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
                try:
                    state.next_at = next_occurrence(feature.schedule, feature.updated_at)
                except (ValueError, OverflowError):
                    # Older validators accepted invalid clocks and date/zone combinations
                    # that overflow UTC conversion. Isolate the definition until its next
                    # edit so one stored invalid schedule cannot roll back every tick.
                    state.next_at = None
                    logger.warning(
                        "Skipping invalid automation schedule for feature %s", feature.id
                    )
                    continue
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
    _fail_news_refresh(session, job, code)


def _fail_news_refresh(session, job, code):
    if job.news_generation is not None:
        from mori.integrations.models import NewsBriefing

        # Cancellation does not hold the feature lock used by manual refreshes.
        # Check the generation in the write itself so a newer result cannot be
        # overwritten between a stale read and this transaction's commit.
        session.execute(
            update(NewsBriefing)
            .where(
                NewsBriefing.feature_id == job.feature_id,
                NewsBriefing.generation == job.news_generation,
                NewsBriefing.status == "loading",
            )
            .values(status="failed", error_code=code)
        )


def _cancel(session, job, now, code):
    job.status = "cancelled"
    job.error_code = code
    job.completed_at = now
    job.lease_token = job.lease_until = None
    _close_turn(session, job, code, cancelled=True)


def cancel_job(session, user_id, job_id, *, now=None):
    """Cancel one occurrence without changing the feature's future schedule."""
    job = session.scalar(
        select(AutomationJob)
        .where(AutomationJob.id == job_id, AutomationJob.user_id == user_id)
        .with_for_update()
    )
    if job is None:
        raise ApiError(404, "AUTOMATION_JOB_NOT_FOUND", "예약 실행을 찾을 수 없습니다.")
    if job.status in {"pending", "running"}:
        _cancel(session, job, now or datetime.now(UTC), "USER_CANCELLED")
    return job


def _active_feature(session, job):
    # Manual chat/news publication locks User before Feature. Claiming also
    # inserts a conversation with a User foreign key, so use this order for
    # every worker path, not just final publication.
    if session.get(User, job.user_id, with_for_update=True) is None:
        return None
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
    for _ in range(100):
        # Commit each discarded occurrence before examining another user's job.
        # Retaining its User lock lets competing workers acquire users in reverse
        # order despite SKIP LOCKED on the individual job rows.
        with factory.begin() as session:
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
            if job.run_id is not None:
                turn = session.get(ChatTurn, job.run_id, with_for_update=True)
                if turn is None or turn.status != "running":
                    _cancel(session, job, now, "RUN_ENDED")
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
                    durable=True,
                    events=[],
                    deadline=job.lease_until,
                )
                session.add(turn)
                session.flush()
                job.run_id = turn.id
            else:
                turn.durable = True
                turn.deadline = job.lease_until
            store.append(
                turn,
                "run.accepted" if job.attempts == 1 else "run.retrying",
                message="예약한 기능을 실행하고 있어요.",
            )
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
    from mori.integrations.news import begin_briefing

    now = now or datetime.now(UTC)
    with factory.begin() as session:
        job = _leased(session, claim, now)
        if job is None:
            return None
        feature = _active_feature(session, job)
        if feature is None:
            _cancel(session, job, now, "FEATURE_CHANGED_OR_PAUSED")
            return None
        row = begin_briefing(session, feature)
        job.news_generation = row.generation
        return row.generation


def complete_job(
    factory,
    claim,
    decision=None,
    *,
    articles=None,
    news_summary=None,
    news_generation=None,
    quote=None,
    watch_revision=None,
    settings=None,
    runtime_url=None,
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
        if turn is None or turn.status != "running":
            _cancel(session, job, now, "RUN_ENDED")
            return False
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
            briefing = store_briefing(session, feature, articles, now, summary=news_summary)
            if news_summary and news_summary.error:
                answer = (
                    "뉴스 요약을 완료하지 못해 이전 브리핑을 유지했어요."
                    if briefing.summary_text
                    else "기사는 수집했지만 요약을 완료하지 못했어요."
                )
            else:
                answer = (
                    news_summary.text
                    if news_summary and news_summary.text
                    else "뉴스 브리핑을 수집했어요."
                )
            store.append(
                turn,
                "result.saved",
                feature_id=str(job.feature_id),
                detail_url="/v1/news",
                result_ref={
                    "resource_id": str(job.feature_id),
                    "kind": "news",
                    "detail_url": "/v1/news",
                },
            )
        else:
            if quote is not None:
                from mori.integrations.models import MarketWatch
                from mori.integrations.service import store_market_snapshot

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
                store_market_snapshot(watch, quote, now)
                answer = (
                    f"{quote.symbol}: {quote.price:g} {quote.currency} "
                    f"(시세 기준 {quote.as_of.isoformat()}, 제공자 {quote.provider})"
                )
                # The stock detail opens the latest snapshot; the FeatureResult
                # below retains this occurrence's original quote and provenance.
                store.append(
                    turn,
                    "result.saved",
                    feature_id=str(job.feature_id),
                    detail_url="/v1/market/snapshot",
                    result_ref={
                        "resource_id": str(watch.id),
                        "kind": "stock",
                        "detail_url": "/v1/market/snapshot",
                    },
                )
            else:
                from mori.features.policy import permitted_actions

                actions = permitted_actions(job.feature_snapshot, decision)
                if settings is not None:
                    user = session.get(User, job.user_id, with_for_update=True)
                    if user is None:
                        raise ApiError(404, "USER_NOT_FOUND", "사용자를 찾을 수 없습니다.")
                    runtime = resolve_runtime(settings, user.id, user.tier, session=session)
                    if runtime_url is not None and runtime.url != runtime_url:
                        raise ApiError(
                            409, "CHAT_RUNTIME_CHANGED", "에이전트 배정이 변경되었습니다."
                        )
                elif any(action.action != "reply" for action in actions):
                    raise ApiError(
                        503, "FEATURE_EXECUTION_NOT_CONFIGURED", "기능 실행 환경이 필요합니다."
                    )
                answer, _ = store.execute_actions(session, turn, job.user_id, decision, settings)
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
        if job.status == "failed":
            _close_turn(session, job, code)
        else:
            turn = session.get(ChatTurn, job.run_id, with_for_update=True)
            if turn is None or turn.status != "running":
                _cancel(session, job, now, "RUN_ENDED")
                return False
            store.append(
                turn,
                "run.retrying",
                code=code,
                message="예약 실행을 다시 시도할게요.",
                next_attempt_at=job.available_at.isoformat(),
            )
            _fail_news_refresh(session, job, code)
        return True


async def _execute(factory, settings, claim, transport, news_generation=None):
    if claim.feature_snapshot.get("builtin_key") == "news":
        from mori.integrations.news import fetch_articles, summarize_articles

        topic = claim.feature_snapshot.get("work") or claim.feature_snapshot["title"]
        articles = await fetch_articles(settings, topic, transport=transport)
        summary = await summarize_articles(
            factory, settings, claim.user_id, topic, articles, transport=transport
        )
        return await asyncio.to_thread(
            complete_job,
            factory,
            claim,
            articles=articles,
            news_generation=news_generation,
            news_summary=summary,
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
        runtime = resolve_runtime(settings, user.id, user.tier, session=session)
    context = await asyncio.to_thread(
        execution_context,
        factory,
        claim.user_id,
        claim.run_id,
        reference_at=claim.scheduled_at,
    )
    async with asyncio.timeout(settings.hermes_timeout_seconds):
        async with httpx.AsyncClient(
            transport=transport, follow_redirects=False, trust_env=False
        ) as client:
            async for value in interpret(
                client,
                runtime,
                settings,
                "선택한 예약 기능의 작업 내용을 실행해 주세요.",
                [],
                context,
            ):
                if isinstance(value, Decision):
                    return await asyncio.to_thread(
                        complete_job,
                        factory,
                        claim,
                        value,
                        settings=settings,
                        runtime_url=runtime.url,
                    )
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
