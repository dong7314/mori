from fastapi import APIRouter, Request

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.operations.service import worker_status

router = APIRouter(prefix="/v1", tags=["capabilities"])


@router.get("/capabilities")
def capabilities(user: CurrentUser, session: DatabaseSession, request: Request):
    settings = request.app.state.settings
    configured = {
        "chat": settings.chat_enabled and settings.chat_worker_enabled,
        "automation": settings.automation_enabled,
        "push": settings.push_enabled,
        "documents": settings.documents_enabled,
        "billing": settings.billing_enabled,
        "provisioning": settings.runtime_provisioning_enabled,
    }
    return {
        "workers": {
            name: {"configured": enabled, **worker_status(session, name, max_age=90)}
            for name, enabled in configured.items()
        },
        "scheduling": {"owner": "mori", "prewarm_seconds": settings.automation_prewarm_seconds},
        "speech": {"configured": bool(settings.speech_base_url), "mode": "transcription"},
        "documents": {
            "enabled": settings.documents_enabled,
            "max_bytes": settings.document_max_bytes,
            "quota_bytes": settings.document_user_quota_bytes,
            "trash_retention_days": settings.document_trash_days,
            "read": ["txt", "md", "csv", "docx", "xlsx", "pdf", "hwp", "hwpx"],
            "create_edit": ["txt", "md", "csv", "docx", "xlsx", "pdf"],
            "conversion": "text_reflow",
            "ocr": False,
            "spreadsheet_recalculation": False,
            "pdf_edit": "page_selection_rotation",
            "hwp_edit": False,
        },
    }
