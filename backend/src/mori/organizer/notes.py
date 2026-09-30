from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES
from mori.organizer import service
from mori.organizer.models import Note
from mori.organizer.schemas import NoteRead, NoteUpdate, NoteWrite, Revision

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1/notes", tags=["notes"])


@router.post("", response_model=NoteRead, status_code=201)
def create(
    payload: NoteWrite,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    return service.idempotent_create(
        session,
        user.id,
        "notes",
        idempotency_key,
        payload,
        lambda: service.create_record(session, Note, user.id, payload),
        NoteRead.model_validate,
    )


@router.get("", response_model=list[NoteRead])
def list_items(
    user: CurrentUser,
    session: DatabaseSession,
    q: str = Query("", max_length=200),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    return list(
        session.scalars(
            select(Note)
            .where(
                Note.user_id == user.id,
                Note.deleted_at.is_(None),
                (
                    Note.title.icontains(q, autoescape=True)
                    | Note.body.icontains(q, autoescape=True)
                ),
            )
            .order_by(Note.updated_at.desc(), Note.id.desc())
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/{resource_id}", response_model=NoteRead)
def detail(resource_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned(session, Note, user.id, resource_id)


@router.delete("/{resource_id}", response_model=NoteRead)
def delete(
    resource_id: UUID, user: CurrentUser, session: DatabaseSession, revision: int = Query(ge=1)
):
    return service.set_deleted(session, Note, user.id, resource_id, revision)


@router.post("/{resource_id}/restore", response_model=NoteRead)
def restore(resource_id: UUID, payload: Revision, user: CurrentUser, session: DatabaseSession):
    return service.set_deleted(session, Note, user.id, resource_id, payload.revision, restore=True)


@router.put("/{resource_id}", response_model=NoteRead)
def replace(resource_id: UUID, payload: NoteUpdate, user: CurrentUser, session: DatabaseSession):
    row = service.update_record(session, Note, user.id, resource_id, payload)
    session.commit()
    return row
