from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Header, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import defer

from mori.artifacts import service
from mori.artifacts.models import DocumentJob, StoredFile
from mori.artifacts.schemas import DocumentJobRead, DocumentRequest, FileRead
from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError

router = APIRouter(prefix="/v1", tags=["documents"], responses=PRIVATE_API_RESPONSES)


@router.post(
    "/files",
    response_model=FileRead,
    status_code=201,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
        }
    },
)
async def upload(
    request: Request,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
    filename: str = Query(min_length=1, max_length=120),
):
    settings = request.app.state.settings
    if not settings.documents_enabled:
        raise ApiError(503, "DOCUMENTS_NOT_CONFIGURED", "파일 서비스가 설정되지 않았습니다.")
    service.filename_format(filename)
    content = bytearray()
    async for part in request.stream():
        content.extend(part)
        if len(content) > settings.document_max_bytes:
            raise ApiError(413, "FILE_SIZE_LIMIT", "파일 크기 제한을 초과했습니다.")
    row = service.save_file(session, user.id, filename, bytes(content), idempotency_key, settings)
    session.commit()
    return row


@router.get("/files", response_model=list[FileRead])
def files(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    trash: bool = False,
):
    return list(
        session.scalars(
            select(StoredFile)
            .options(defer(StoredFile.content))
            .where(
                StoredFile.user_id == user.id,
                StoredFile.deleted_at.is_not(None) if trash else StoredFile.deleted_at.is_(None),
            )
            .order_by(StoredFile.created_at.desc(), StoredFile.id)
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/files/{file_id}", response_model=FileRead)
def detail(file_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned_file(session, user.id, file_id, content=False)


@router.get("/files/{file_id}/content")
def download(file_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = service.owned_file(session, user.id, file_id)
    return Response(
        row.content,
        media_type=row.media_type,
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(row.filename, safe=""),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.delete("/files/{file_id}", response_model=FileRead)
def delete(file_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = service.owned_file(session, user.id, file_id, deleted=True, lock=True, content=False)
    row.deleted_at = row.deleted_at or datetime.now(UTC)
    session.commit()
    return row


@router.post("/files/{file_id}/restore", response_model=FileRead)
def restore(file_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = service.owned_file(session, user.id, file_id, deleted=True, lock=True, content=False)
    if row.purged_at is not None:
        raise ApiError(410, "FILE_EXPIRED", "보관 기간이 끝나 원본 파일이 삭제됐습니다.")
    row.deleted_at = None
    session.commit()
    return row


@router.post("/document-jobs", response_model=DocumentJobRead, status_code=202)
def submit(
    payload: DocumentRequest,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    row = service.create_job(session, user.id, payload, idempotency_key, request.app.state.settings)
    session.commit()
    return row


@router.get("/document-jobs", response_model=list[DocumentJobRead])
def jobs(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return list(
        session.scalars(
            select(DocumentJob)
            .where(DocumentJob.user_id == user.id)
            .order_by(DocumentJob.created_at.desc(), DocumentJob.id)
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/document-jobs/{job_id}", response_model=DocumentJobRead)
def job(job_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.owned_job(session, user.id, job_id)


@router.post("/document-jobs/{job_id}/cancel", response_model=DocumentJobRead)
def cancel(job_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = service.cancel_job(session, user.id, job_id)
    session.commit()
    return row


@router.post("/document-jobs/{job_id}/retry", response_model=DocumentJobRead, status_code=202)
def retry(
    job_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    row = service.retry_job(session, user.id, job_id, idempotency_key, request.app.state.settings)
    session.commit()
    return row
