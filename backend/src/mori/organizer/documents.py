from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Header, Query, Response
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES
from mori.organizer import service
from mori.organizer.models import Document
from mori.organizer.schemas import DocumentRead, DocumentWrite, Revision

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1/documents", tags=["documents"])


@router.post("", response_model=DocumentRead, status_code=201)
def create(
    payload: DocumentWrite,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    return service.idempotent_create(
        session,
        user.id,
        "documents",
        idempotency_key,
        payload,
        lambda: service.create_record(session, Document, user.id, payload),
        DocumentRead.model_validate,
    )


@router.get("", response_model=list[DocumentRead])
def list_items(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    return list(
        session.scalars(
            select(Document)
            .where(
                Document.user_id == user.id,
                Document.deleted_at.is_(None),
            )
            .order_by(Document.updated_at.desc(), Document.id.desc())
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/{resource_id}", response_model=DocumentRead)
def detail(resource_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned(session, Document, user.id, resource_id)


@router.delete("/{resource_id}", response_model=DocumentRead)
def delete(
    resource_id: UUID, user: CurrentUser, session: DatabaseSession, revision: int = Query(ge=1)
):
    return service.set_deleted(session, Document, user.id, resource_id, revision)


@router.post("/{resource_id}/restore", response_model=DocumentRead)
def restore(resource_id: UUID, payload: Revision, user: CurrentUser, session: DatabaseSession):
    return service.set_deleted(
        session, Document, user.id, resource_id, payload.revision, restore=True
    )


@router.get(
    "/{resource_id}/download",
    response_class=Response,
    responses={200: {"content": {"text/plain": {"schema": {"type": "string"}}}}},
)
def download(resource_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = service.owned(session, Document, user.id, resource_id)
    return Response(
        row.text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(row.filename, safe=""),
            "X-Content-Type-Options": "nosniff",
        },
    )
