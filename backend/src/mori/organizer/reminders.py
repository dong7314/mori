from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query, Request
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.notifications.models import PushSubscription
from mori.organizer import service
from mori.organizer.models import Reminder
from mori.organizer.schemas import (
    ReminderExtend,
    ReminderRead,
    ReminderResume,
    ReminderUpdate,
    ReminderWrite,
    Revision,
)

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1/reminders", tags=["reminders"])


def delivery_availability(session, user_id, request):
    if not request.app.state.settings.push_enabled:
        return "not_configured"
    subscription = session.scalar(
        select(PushSubscription.id)
        .where(PushSubscription.user_id == user_id, PushSubscription.active.is_(True))
        .limit(1)
    )
    return "ready" if subscription is not None else "no_subscription"


def read_record(row, user, session, request, *, availability=None):
    status = availability or delivery_availability(session, user.id, request)
    return ReminderRead.model_validate(row).model_copy(update={"delivery_status": status})


@router.post("", response_model=ReminderRead, status_code=201)
def create(
    payload: ReminderWrite,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    row = service.idempotent_create(
        session,
        user.id,
        "reminders",
        idempotency_key,
        payload,
        lambda: service.create_record(session, Reminder, user.id, payload),
        ReminderRead.model_validate,
    )
    return read_record(row, user, session, request)


@router.get("", response_model=list[ReminderRead])
def list_items(
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    rows = list(
        session.scalars(
            select(Reminder)
            .where(
                Reminder.user_id == user.id,
                Reminder.deleted_at.is_(None),
            )
            .order_by(Reminder.updated_at.desc(), Reminder.id.desc())
            .offset(offset)
            .limit(limit)
        )
    )
    availability = delivery_availability(session, user.id, request)
    return [read_record(row, user, session, request, availability=availability) for row in rows]


@router.get("/{resource_id}", response_model=ReminderRead)
def detail(resource_id: UUID, user: CurrentUser, session: DatabaseSession, request: Request):
    return read_record(
        service.owned(session, Reminder, user.id, resource_id), user, session, request
    )


@router.delete("/{resource_id}", response_model=ReminderRead)
def delete(
    resource_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    revision: int = Query(ge=1),
):
    row = service.set_deleted(session, Reminder, user.id, resource_id, revision)
    return read_record(row, user, session, request)


@router.post("/{resource_id}/restore", response_model=ReminderRead)
def restore(
    resource_id: UUID,
    payload: Revision,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    row = service.set_deleted(
        session, Reminder, user.id, resource_id, payload.revision, restore=True
    )
    return read_record(row, user, session, request)


@router.put("/{resource_id}", response_model=ReminderRead)
def replace(
    resource_id: UUID,
    payload: ReminderUpdate,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    row = service.update_record(session, Reminder, user.id, resource_id, payload)
    session.commit()
    return read_record(row, user, session, request)


@router.post("/{resource_id}/cancel", response_model=ReminderRead)
def cancel(
    resource_id: UUID,
    payload: Revision,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    row = service.owned(session, Reminder, user.id, resource_id, lock=True)
    service.check_revision(row, payload.revision)
    if not row.cancelled:
        row.cancelled = True
        row.revision += 1
        row.updated_at = datetime.now(UTC)
    session.commit()
    return read_record(row, user, session, request)


@router.post("/{resource_id}/resume", response_model=ReminderRead)
def resume(
    resource_id: UUID,
    payload: ReminderResume,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    """Restart the same reminder at a future target; keep its original identity."""
    row = service.owned(session, Reminder, user.id, resource_id, lock=True)
    service.check_revision(row, payload.revision)
    now = datetime.now(UTC)
    if payload.target_at <= now:
        raise ApiError(422, "REMINDER_IN_PAST", "알림 목표 시각은 현재 이후여야 합니다.")
    row.target_at = payload.target_at
    row.cancelled = False
    row.revision += 1
    row.updated_at = now
    session.commit()
    return read_record(row, user, session, request)


@router.post("/{resource_id}/extend", response_model=ReminderRead)
def extend(
    resource_id: UUID,
    payload: ReminderExtend,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    """Extend from max(server time, target), resuming a cancelled or elapsed timer."""
    row = service.owned(session, Reminder, user.id, resource_id, lock=True)
    service.check_revision(row, payload.revision)
    now = datetime.now(UTC)
    row.target_at = max(now, row.target_at) + timedelta(minutes=payload.minutes)
    row.cancelled = False
    row.revision += 1
    row.updated_at = now
    session.commit()
    return read_record(row, user, session, request)
