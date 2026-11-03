"""Durable chat execution. Closing an HTTP stream never cancels this queue."""

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select

from mori.auth.models import User
from mori.chat import store
from mori.chat.models import ChatJob, ChatTurn
from mori.chat.runtime import resolve_runtime
from mori.errors import ApiError


@dataclass(frozen=True)
class Claim:
    run_id: UUID
    user_id: UUID
    token: UUID
    message: str
    history: list


def claim_next(factory, settings, *, now=None):
    now = now or datetime.now(UTC)
    with factory.begin() as session:
        job = session.scalar(
            select(ChatJob)
            .where(
                or_(
                    and_(ChatJob.status.in_(("queued", "retry")), ChatJob.available_at <= now),
                    and_(ChatJob.status == "processing", ChatJob.lease_until <= now),
                )
            )
            .order_by(ChatJob.available_at, ChatJob.run_id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        turn = session.get(ChatTurn, job.run_id, with_for_update=True)
        if turn.status != "running":
            job.status = "completed" if turn.status == "completed" else "cancelled"
            job.lease_token = job.lease_until = None
            return None
        if job.attempts >= settings.chat_job_max_attempts:
            job.status, job.error_code = "failed", "CHAT_ATTEMPTS_EXHAUSTED"
            job.lease_token = job.lease_until = None
            turn.status = "failed"
            store.append(
                turn,
                "run.failed",
                code=job.error_code,
                message="작업을 완료하지 못했어요. 다시 요청해 주세요.",
            )
            return None
        job.status = "processing"
        job.attempts += 1
        job.lease_token = uuid4()
        job.lease_until = now + timedelta(
            seconds=max(settings.chat_job_lease_seconds, settings.hermes_timeout_seconds + 60)
        )
        job.updated_at = now
        turn.deadline = now + timedelta(seconds=settings.hermes_timeout_seconds + 30)
        return Claim(turn.id, job.user_id, job.lease_token, turn.message, job.history)


def failed(factory, claim, code, *, retryable=False, max_attempts=3):
    with factory.begin() as session:
        job = session.get(ChatJob, claim.run_id, with_for_update=True)
        if job is None or job.status != "processing" or job.lease_token != claim.token:
            return
        turn = session.get(ChatTurn, claim.run_id, with_for_update=True)
        if turn.status != "running":
            return
        now = datetime.now(UTC)
        retry = retryable and job.attempts < max_attempts
        job.status = "retry" if retry else "failed"
        job.error_code = code
        job.lease_token = job.lease_until = None
        job.updated_at = now
        job.available_at = now + timedelta(seconds=min(60, 5 * 2 ** max(0, job.attempts - 1)))
        if retry:
            store.append(turn, "run.retrying", code=code, message="연결을 다시 시도할게요.")
        else:
            turn.status = "failed"
            store.append(
                turn,
                "run.failed",
                code=code,
                message="작업을 완료하지 못했어요. 대화 기록에서 확인해 주세요.",
            )


async def run_chat_once(factory, settings, *, transport=None, now=None):
    if not settings.chat_worker_enabled:
        return False
    claim = await asyncio.to_thread(claim_next, factory, settings, now=now)
    if claim is None:
        return False
    try:
        with factory() as session:
            user = session.get(User, claim.user_id)
            if user is None:
                raise ApiError(404, "USER_NOT_FOUND", "사용자를 찾을 수 없습니다.")
            runtime = resolve_runtime(settings, user.id, user.tier, session=session)
        # Import here to keep endpoint definitions and queue persistence independent.
        from mori.chat.router import work

        async for _ in work(
            factory,
            claim.run_id,
            claim.user_id,
            settings,
            runtime,
            transport,
            claim.message,
            claim.history,
            lease_token=claim.token,
        ):
            pass
    except asyncio.CancelledError:
        await asyncio.shield(
            asyncio.to_thread(
                failed,
                factory,
                claim,
                "WORKER_STOPPED",
                retryable=True,
                max_attempts=settings.chat_job_max_attempts,
            )
        )
        raise
    except Exception as exc:
        code = exc.code if isinstance(exc, ApiError) else "CHAT_FAILED"
        retryable = code in {
            "HERMES_TIMEOUT",
            "HERMES_UNAVAILABLE",
            "HERMES_UPSTREAM_ERROR",
            "HERMES_NOT_CONFIGURED",
            "RUNTIME_NOT_READY",
        }
        await asyncio.to_thread(
            failed,
            factory,
            claim,
            code,
            retryable=retryable,
            max_attempts=settings.chat_job_max_attempts,
        )
    return True


def cancel(factory, user_id, conversation_id, run_id):
    with factory.begin() as session:
        store.owned(session, conversation_id, user_id, lock=True)
        job = session.get(ChatJob, run_id, with_for_update=True)
        turn = session.get(ChatTurn, run_id, with_for_update=True)
        if (
            job is None
            or turn is None
            or turn.conversation_id != conversation_id
            or job.user_id != user_id
        ):
            raise ApiError(404, "RUN_NOT_FOUND", "작업을 찾을 수 없습니다.")
        if turn.status == "running":
            job.status = "cancelled"
            job.lease_token = job.lease_until = None
            job.updated_at = datetime.now(UTC)
            turn.status = "interrupted"
            store.append(
                turn, "run.interrupted", code="USER_CANCELLED", message="작업을 취소했어요."
            )
    return store.snapshot(factory, user_id, conversation_id, run_id)
