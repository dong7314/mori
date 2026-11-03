"""Prewarm an assigned runtime before due work; Mori remains the schedule owner."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert

from mori.auth.models import User
from mori.automation.models import AutomationScheduleState
from mori.automation.scheduler import enqueue_due
from mori.chat.protocol import check_toolsets, read_json
from mori.chat.runtime import resolve_runtime, runtime_headers
from mori.errors import ApiError
from mori.features.models import Feature
from mori.operations.models import RuntimeWarmup

WARMUP_CONCURRENCY = 4


def claim_warmups(factory, settings, *, now=None):
    now = now or datetime.now(UTC)
    end = now + timedelta(seconds=settings.automation_prewarm_seconds)
    with factory.begin() as session:
        users = list(
            session.scalars(
                select(User)
                .join(Feature, Feature.user_id == User.id)
                .join(AutomationScheduleState, AutomationScheduleState.feature_id == Feature.id)
                .outerjoin(RuntimeWarmup, RuntimeWarmup.user_id == User.id)
                .where(
                    Feature.deleted_at.is_(None),
                    Feature.status == "active",
                    or_(
                        Feature.builtin_key.is_(None),
                        (Feature.builtin_key == "news") & settings.news_summary_enabled,
                    ),
                    AutomationScheduleState.feature_revision == Feature.revision,
                    AutomationScheduleState.next_at > now,
                    AutomationScheduleState.next_at <= end,
                    or_(RuntimeWarmup.user_id.is_(None), RuntimeWarmup.lease_until <= now),
                )
                .distinct()
                .order_by(User.id)
                .limit(100)
            )
        )
        claims = []
        for user in users:
            try:
                runtime = resolve_runtime(settings, user.id, user.tier, session=session)
            except ApiError:
                continue
            lease = now + timedelta(seconds=max(settings.hermes_startup_timeout_seconds + 10, 30))
            accepted = session.execute(
                insert(RuntimeWarmup)
                .values(
                    user_id=user.id,
                    attempted_at=now,
                    lease_until=lease,
                )
                .on_conflict_do_update(
                    index_elements=["user_id"],
                    set_=dict(attempted_at=now, lease_until=lease),
                    where=RuntimeWarmup.lease_until <= now,
                )
                .returning(RuntimeWarmup.user_id)
            ).scalar()
            if accepted:
                claims.append((user.id, now, runtime))
                # Start every leased request immediately; a larger claimed batch can
                # expire behind the semaphore and be taken again by another worker.
                if len(claims) == WARMUP_CONCURRENCY:
                    break
        return claims


def finish_warmup(factory, user_id, attempted, *, error=None):
    with factory.begin() as session:
        row = session.get(RuntimeWarmup, user_id, with_for_update=True)
        if row and row.attempted_at == attempted:
            row.error_code = error
            now = max(datetime.now(UTC), attempted)
            # Repeat authenticated keepalive within Knative's idle window until due time.
            row.lease_until = now + timedelta(seconds=20 if not error else 30)
            if not error:
                row.ready_at = now


async def prewarm_once(factory, settings, *, transport=None, now=None):
    if not settings.automation_enabled or settings.automation_prewarm_seconds <= 0:
        return 0
    await asyncio.to_thread(enqueue_due, factory, now=now)
    claims = await asyncio.to_thread(claim_warmups, factory, settings, now=now)
    semaphore = asyncio.Semaphore(WARMUP_CONCURRENCY)

    async def warm(claim):
        user_id, attempted, runtime = claim
        error = None
        async with semaphore:
            try:
                async with httpx.AsyncClient(
                    transport=transport, trust_env=False, follow_redirects=False
                ) as client:
                    payload = await read_json(
                        client,
                        "GET",
                        runtime.url + "/v1/toolsets",
                        runtime_headers(runtime),
                        timeout=settings.hermes_startup_timeout_seconds,
                    )
                    check_toolsets(payload)
            except Exception as exc:
                error = exc.code if isinstance(exc, ApiError) else "RUNTIME_PREWARM_FAILED"
            await asyncio.to_thread(finish_warmup, factory, user_id, attempted, error=error)

    await asyncio.gather(*(warm(claim) for claim in claims))
    return len(claims)
