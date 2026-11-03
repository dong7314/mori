import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import defer

from mori.artifacts.models import DocumentJob, StoredFile
from mori.errors import ApiError
from mori.organizer.service import lock_user

MEDIA = {
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
    "hwp": "application/x-hwp",
    "hwpx": "application/hwp+zip",
}


def filename_format(filename):
    if (
        not filename
        or len(filename) > 120
        or "/" in filename
        or "\\" in filename
        or any(ord(c) < 32 or ord(c) == 127 for c in filename)
    ):
        raise ApiError(422, "INVALID_FILENAME", "파일 이름을 확인해 주세요.")
    fmt = filename.rsplit(".", 1)[-1].lower()
    if fmt not in MEDIA:
        raise ApiError(422, "UNSUPPORTED_DOCUMENT", "지원하지 않는 문서 형식입니다.")
    return fmt


def owned_file(session, user_id, file_id, *, deleted=False, lock=False, content=True):
    query = select(StoredFile).where(StoredFile.id == file_id, StoredFile.user_id == user_id)
    if lock:
        query = query.with_for_update()
    if not content:
        query = query.options(defer(StoredFile.content))
    row = session.scalar(query)
    if row is None or (row.deleted_at and not deleted):
        raise ApiError(404, "FILE_NOT_FOUND", "파일을 찾을 수 없습니다.")
    return row


def save_file(session, user_id, filename, content, key, settings):
    fmt = filename_format(filename)
    if not content or len(content) > settings.document_max_bytes:
        raise ApiError(413, "FILE_SIZE_LIMIT", "파일 크기 제한을 확인해 주세요.")
    lock_user(session, user_id)
    digest = hashlib.sha256(content).hexdigest()
    prior = session.scalar(
        select(StoredFile).where(StoredFile.user_id == user_id, StoredFile.upload_key == key)
    )
    if prior:
        if prior.sha256 != digest or prior.filename != filename:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 파일이 전달됐습니다.")
        return prior
    usage = session.scalar(
        select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
            StoredFile.user_id == user_id
        )
    )
    if usage + len(content) > settings.document_user_quota_bytes:
        raise ApiError(409, "FILE_QUOTA_EXCEEDED", "파일 보관 용량을 초과했습니다.")
    row = StoredFile(
        user_id=user_id,
        upload_key=key,
        filename=filename,
        media_type=MEDIA[fmt],
        size_bytes=len(content),
        sha256=digest,
        content=content,
    )
    session.add(row)
    session.flush()
    return row


def create_job(session, user_id, payload, key, settings):
    if not settings.documents_enabled:
        raise ApiError(503, "DOCUMENTS_NOT_CONFIGURED", "문서 처리 worker가 설정되지 않았습니다.")
    raw = json.dumps(payload.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    lock_user(session, user_id)
    prior = session.scalar(
        select(DocumentJob).where(DocumentJob.user_id == user_id, DocumentJob.request_key == key)
    )
    if prior:
        if prior.request_hash != digest:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 작업이 전달됐습니다.")
        return prior
    if payload.source_file_id:
        source = owned_file(session, user_id, payload.source_file_id)
        if payload.operation == "edit" and filename_format(source.filename) in ("hwp", "hwpx"):
            raise ApiError(
                422, "DOCUMENT_EDIT_UNSUPPORTED", "한글 문서는 DOCX로 변환한 뒤 편집해 주세요."
            )
    pending = session.scalar(
        select(func.count())
        .select_from(DocumentJob)
        .where(DocumentJob.user_id == user_id, DocumentJob.status.in_(["pending", "running"]))
    )
    if pending >= 10:
        raise ApiError(429, "DOCUMENT_QUEUE_FULL", "진행 중인 문서 작업을 먼저 완료해 주세요.")
    row = DocumentJob(user_id=user_id, request_key=key, request_hash=digest, **payload.model_dump())
    session.add(row)
    session.flush()
    return row


def claim_job(factory):
    now = datetime.now(UTC)
    with factory.begin() as session:
        jobs = list(
            session.scalars(
                select(DocumentJob)
                .where(
                    or_(
                        DocumentJob.status == "pending",
                        (DocumentJob.status == "running") & (DocumentJob.lease_until < now),
                    )
                )
                .order_by(DocumentJob.created_at)
                .limit(10)
                .with_for_update(skip_locked=True)
            )
        )
        for row in jobs:
            if row.attempts >= 3:
                row.status = "failed"
                row.error_code = "WORKER_INTERRUPTED"
                row.completed_at = now
                row.lease_token = None
                row.lease_until = None
                continue
            row.status = "running"
            row.attempts += 1
            row.lease_token = uuid4()
            row.lease_until = now + timedelta(seconds=90)
            return row
    return None


def invoke_engine(settings, args, root):
    env = {
        "PATH": os.environ.get("PATH", ""),
        "LANG": "C.UTF-8",
        "MORI_DOCUMENT_FONT": settings.document_font_path,
        "TMPDIR": str(root),
    }
    process = subprocess.run(
        [sys.executable, "-m", "mori.artifacts.engine"],
        input=json.dumps(args, ensure_ascii=False).encode(),
        capture_output=True,
        timeout=40,
        cwd=root,
        env=env,
    )
    if process.returncode or len(process.stdout) > 220_000:
        raise ValueError("Document worker failed")
    result = json.loads(process.stdout)
    if not isinstance(result, dict) or result.get("success") is not True:
        raise ValueError("Document operation rejected")
    return result


def extract_file(settings, file_id, content, fmt):
    """Read an explicitly owned attachment using the same bounded parser as document jobs."""
    with tempfile.TemporaryDirectory(prefix="mori-attachment-") as folder:
        root = Path(folder)
        name = file_id.hex + "." + fmt
        (root / name).write_bytes(content)
        return invoke_engine(settings, {"operation": "read", "file_id": name}, root)["data"]


def process_document(factory, settings, job):
    with factory() as session:
        source = (
            owned_file(session, job.user_id, job.source_file_id) if job.source_file_id else None
        )
        content = source.content if source else None
        fmt = filename_format(source.filename) if source else None
    with tempfile.TemporaryDirectory(prefix="mori-document-") as folder:
        root = Path(folder)
        args = dict(operation=job.operation, spec=job.spec)
        if job.format:
            args["format"] = job.format
        if source:
            args["file_id"] = source.id.hex + "." + fmt
            (root / args["file_id"]).write_bytes(content)
        result = invoke_engine(settings, args, root)
        output = None
        if job.operation != "read":
            file_id = result.get("file_id", "")
            if not re.fullmatch(r"[0-9a-f]{32}[.](txt|md|csv|docx|xlsx|pdf)", file_id):
                raise ValueError("Invalid output file")
            with (root / file_id).open("rb") as stream:
                output = stream.read(settings.document_max_bytes + 1)
            if len(output) > settings.document_max_bytes:
                raise ValueError("Output exceeds size limit")
        with factory.begin() as session:
            row = session.get(DocumentJob, job.id, with_for_update=True)
            if (
                row.status != "running"
                or row.lease_token != job.lease_token
                or row.lease_until < datetime.now(UTC)
            ):
                return
            # Match chat publication's user -> source lock order before allocating output quota.
            lock_user(session, job.user_id)
            if source:
                owned_file(session, job.user_id, source.id, lock=True, content=False)
            if output is not None:
                output_format = result["format"]
                name = (
                    (source.filename.rsplit(".", 1)[0] if source else "document")[:90]
                    + "."
                    + output_format
                )
                artifact = save_file(session, job.user_id, name, output, job.id, settings)
                row.output_file_id = artifact.id
            # Never expose scratch paths or parser's internal file IDs.
            row.result = {k: v for k, v in result.items() if k not in ("file_id", "source_file_id")}
            row.status = "completed"
            row.completed_at = datetime.now(UTC)
            row.lease_until = None
            row.lease_token = None


async def run_document_once(factory, settings):
    if not settings.documents_enabled:
        return False
    await asyncio.to_thread(purge_expired_files, factory, settings)
    job = await asyncio.to_thread(claim_job, factory)
    if job is None:
        return False
    try:
        await asyncio.to_thread(process_document, factory, settings, job)
    except Exception as exc:
        with factory.begin() as session:
            row = session.get(DocumentJob, job.id, with_for_update=True)
            if row.status == "running" and row.lease_token == job.lease_token:
                row.status = "failed"
                row.completed_at = datetime.now(UTC)
                row.error_code = (
                    exc.code if isinstance(exc, ApiError) else "DOCUMENT_PROCESSING_FAILED"
                )
                row.lease_until = None
                row.lease_token = None
    return True


def purge_expired_files(factory, settings, now=None):
    now = now or datetime.now(UTC)
    with factory.begin() as session:
        result = session.execute(
            update(StoredFile)
            .where(
                StoredFile.deleted_at <= now - timedelta(days=settings.document_trash_days),
                StoredFile.purged_at.is_(None),
            )
            .values(content=b"", size_bytes=0, purged_at=now)
        )
        return result.rowcount


def owned_job(session, user_id, job_id, *, lock=False):
    query = select(DocumentJob).where(DocumentJob.id == job_id, DocumentJob.user_id == user_id)
    row = session.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise ApiError(404, "DOCUMENT_JOB_NOT_FOUND", "문서 작업을 찾을 수 없습니다.")
    return row


def cancel_job(session, user_id, job_id):
    row = owned_job(session, user_id, job_id, lock=True)
    if row.status in {"pending", "running"}:
        row.status = "cancelled"
        row.error_code = None
        row.completed_at = datetime.now(UTC)
        row.lease_token = row.lease_until = None
    return row


def retry_job(session, user_id, job_id, key, settings):
    from mori.artifacts.schemas import DocumentRequest

    source = owned_job(session, user_id, job_id)
    if source.status not in {"failed", "cancelled"}:
        raise ApiError(
            409, "DOCUMENT_RETRY_UNAVAILABLE", "실패하거나 취소한 작업만 다시 실행할 수 있습니다."
        )
    if source.request_key == key:
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "재실행에는 새로운 요청 키가 필요합니다.")
    return create_job(
        session,
        user_id,
        DocumentRequest(
            operation=source.operation,
            format=source.format,
            source_file_id=source.source_file_id,
            spec=source.spec,
        ),
        key,
        settings,
    )
