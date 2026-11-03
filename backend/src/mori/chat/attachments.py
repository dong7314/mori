"""Explicit attachments are owned references, never caller-supplied paths or model tools."""

import json
from uuid import UUID

from mori.artifacts.service import extract_file, filename_format, owned_file
from mori.errors import ApiError
from mori.organizer.models import Document
from mori.organizer.service import owned

PREVIEW_CHARS = 10000


def attachment_source(session, user_id, ref, *, lock=False):
    if ref["kind"] == "file":
        return owned_file(session, user_id, UUID(ref["id"]), lock=lock, content=False)
    return owned(session, Document, user_id, UUID(ref["id"]), lock=lock)


def validate_attachments(session, user_id, refs, *, lock=False):
    for ref in sorted(refs, key=lambda item: (item["kind"], item["id"])):
        attachment_source(session, user_id, ref, lock=lock)


def prepare_attachments(factory, settings, user_id, run_id, lease_token):
    from mori.chat import store

    with factory.begin() as session:
        turn, _ = store.checked_turn(session, run_id, lease_token)
        refs = turn.attachments
        validate_attachments(session, user_id, refs)
    result = []
    for ref in refs:
        store.progress(
            factory,
            run_id,
            "attachment.started",
            lease_token=lease_token,
            attachment=ref,
            message="첨부한 문서를 읽고 있어요.",
        )
        with factory() as session:
            source = attachment_source(session, user_id, ref)
            filename = source.filename
            if ref["kind"] == "file":
                if not settings.documents_enabled:
                    raise ApiError(
                        503, "DOCUMENTS_NOT_CONFIGURED", "문서 처리가 설정되지 않았습니다."
                    )
                content = source.content
                fmt = filename_format(filename)
            else:
                data = {
                    "text": source.text[:PREVIEW_CHARS],
                    "truncated": len(source.text) > PREVIEW_CHARS,
                }
        if ref["kind"] == "file":
            try:
                data = extract_file(settings, UUID(ref["id"]), content, fmt)
            except Exception as exc:
                raise ApiError(
                    422, "ATTACHMENT_UNREADABLE", "첨부 문서의 내용을 읽지 못했습니다."
                ) from exc
        preview = json.dumps(data, ensure_ascii=False)
        result.append(
            {
                **ref,
                "filename": filename,
                "extracted_data_preview": preview[:PREVIEW_CHARS],
                "preview_truncated": len(preview) > PREVIEW_CHARS,
                "untrusted_content": True,
            }
        )
        store.progress(
            factory,
            run_id,
            "attachment.completed",
            lease_token=lease_token,
            attachment=ref,
            message="첨부 문서를 확인했어요.",
        )
    return result
