from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from pydantic import AwareDatetime
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.organizer import service
from mori.organizer.models import CalendarEvent
from mori.organizer.schemas import EventRead, EventUpdate, EventWrite, Revision

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1/calendar/events", tags=["calendar"])


@router.post("", response_model=EventRead, status_code=201)
def create(
    payload: EventWrite,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    return service.idempotent_create(
        session,
        user.id,
        "calendar/events",
        idempotency_key,
        payload,
        lambda: service.create_record(session, CalendarEvent, user.id, payload),
        EventRead.model_validate,
    )


@router.get("", response_model=list[EventRead])
def list_items(
    user: CurrentUser,
    session: DatabaseSession,
    from_at: Annotated[AwareDatetime, Query(alias="from")],
    until: AwareDatetime,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100000),
):
    if until <= from_at or (until - from_at).total_seconds() > 366 * 86400:
        raise ApiError(422, "INVALID_RANGE", "조회 기간은 1년 이내여야 합니다.")
    return list(
        session.scalars(
            select(CalendarEvent)
            .where(
                CalendarEvent.user_id == user.id,
                CalendarEvent.deleted_at.is_(None),
                CalendarEvent.starts_at < until,
                CalendarEvent.ends_at > from_at,
            )
            .order_by(CalendarEvent.starts_at, CalendarEvent.id)
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/{resource_id}", response_model=EventRead)
def detail(resource_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned(session, CalendarEvent, user.id, resource_id)


@router.delete("/{resource_id}", response_model=EventRead)
def delete(
    resource_id: UUID, user: CurrentUser, session: DatabaseSession, revision: int = Query(ge=1)
):
    return service.set_deleted(session, CalendarEvent, user.id, resource_id, revision)


@router.post("/{resource_id}/restore", response_model=EventRead)
def restore(resource_id: UUID, payload: Revision, user: CurrentUser, session: DatabaseSession):
    return service.set_deleted(
        session, CalendarEvent, user.id, resource_id, payload.revision, restore=True
    )


@router.put("/{resource_id}", response_model=EventRead)
def replace(resource_id: UUID, payload: EventUpdate, user: CurrentUser, session: DatabaseSession):
    row = service.update_record(session, CalendarEvent, user.id, resource_id, payload)
    session.commit()
    return row
