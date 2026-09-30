from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES
from mori.organizer import service
from mori.organizer.models import Reminder
from mori.organizer.schemas import ReminderRead, ReminderUpdate, ReminderWrite, Revision

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1/reminders", tags=["reminders"])


@router.post("", response_model=ReminderRead, status_code=201)
def create(
    payload: ReminderWrite,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    return service.idempotent_create(
        session,
        user.id,
        "reminders",
        idempotency_key,
        payload,
        lambda: service.create_record(session, Reminder, user.id, payload),
        ReminderRead.model_validate,
    )


@router.get("", response_model=list[ReminderRead])
def list_items(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    return list(
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


@router.get("/{resource_id}", response_model=ReminderRead)
def detail(resource_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned(session, Reminder, user.id, resource_id)


@router.delete("/{resource_id}", response_model=ReminderRead)
def delete(
    resource_id: UUID, user: CurrentUser, session: DatabaseSession, revision: int = Query(ge=1)
):
    return service.set_deleted(session, Reminder, user.id, resource_id, revision)


@router.post("/{resource_id}/restore", response_model=ReminderRead)
def restore(resource_id: UUID, payload: Revision, user: CurrentUser, session: DatabaseSession):
    return service.set_deleted(
        session, Reminder, user.id, resource_id, payload.revision, restore=True
    )


@router.put("/{resource_id}", response_model=ReminderRead)
def replace(
    resource_id: UUID, payload: ReminderUpdate, user: CurrentUser, session: DatabaseSession
):
    row = service.update_record(session, Reminder, user.id, resource_id, payload)
    session.commit()
    return row


@router.post("/{resource_id}/cancel", response_model=ReminderRead)
def cancel(resource_id: UUID, payload: Revision, user: CurrentUser, session: DatabaseSession):
    row = service.owned(session, Reminder, user.id, resource_id, lock=True)
    service.check_revision(row, payload.revision)
    if not row.cancelled:
        row.cancelled = True
        row.revision += 1
        row.updated_at = datetime.now(UTC)
    session.commit()
    return row
