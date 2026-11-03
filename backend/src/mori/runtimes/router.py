from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.auth.models import User
from mori.billing.service import effective_tier
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.runtimes.models import RuntimeBinding
from mori.runtimes.service import encrypt_key

router = APIRouter(prefix="/v1/me/runtime", tags=["runtime"], responses=PRIVATE_API_RESPONSES)


class RuntimeRead(BaseModel):
    status: Literal[
        "not_requested",
        "not_configured",
        "configured",
        "pending",
        "provisioning",
        "ready",
        "retry",
        "suspending",
        "suspended",
    ]
    access_allowed: bool
    source: Literal["managed", "operator_assigned", "shared_isolated", "none"] = "none"
    error_code: str | None = None
    ready_at: datetime | None = None
    updated_at: datetime | None = None
    storage_retained: bool = False


def public_status(user, row, settings):
    manual = str(user.id) in getattr(settings, "chat_private_runtimes", {})
    managed = user.tier == "pro" and settings.runtime_provisioning_enabled and row is not None
    if user.tier == "pro" and manual and not managed:
        return RuntimeRead(
            status="configured",
            source="operator_assigned",
            access_allowed=settings.chat_enabled,
            storage_retained=row is not None,
        )
    if settings.shared_hermes_enabled and (
        user.tier != "pro" or not settings.runtime_provisioning_enabled
    ):
        return RuntimeRead(
            status="configured",
            source="shared_isolated",
            access_allowed=settings.chat_enabled,
            storage_retained=row is not None,
        )
    if (
        not manual
        and (user.tier != "pro" or not settings.runtime_provisioning_enabled)
        and user.id == settings.hermes_test_user_id
        and settings.hermes_base_url
        and settings.hermes_api_key.get_secret_value()
    ):
        return RuntimeRead(
            status="configured",
            source="operator_assigned",
            access_allowed=settings.chat_enabled,
            storage_retained=row is not None,
        )
    if user.tier != "pro":
        return RuntimeRead(
            status="suspended"
            if row and row.status == "suspended"
            else "suspending"
            if row
            else "not_requested",
            access_allowed=False,
            source="managed" if row else "none",
            storage_retained=row is not None,
            updated_at=row.updated_at if row else None,
        )
    if not settings.runtime_provisioning_enabled:
        return RuntimeRead(status="not_configured", access_allowed=False)
    if row is None:
        return RuntimeRead(status="pending", access_allowed=False)
    return RuntimeRead(
        status=row.status,
        access_allowed=settings.chat_enabled and row.status == "ready" and row.desired == "active",
        source="managed",
        error_code=row.error_code,
        ready_at=row.ready_at,
        updated_at=row.updated_at,
        storage_retained=row.status in {"suspending", "suspended"},
    )


@router.get("", response_model=RuntimeRead, summary="내 에이전트 배정 및 준비 상태")
def get_status(user: CurrentUser, session: DatabaseSession, request: Request):
    return public_status(user, session.get(RuntimeBinding, user.id), request.app.state.settings)


@router.post("/retry", response_model=RuntimeRead, summary="개인 에이전트 준비 재시도")
def retry(user: CurrentUser, session: DatabaseSession, request: Request):
    settings = request.app.state.settings
    current_user = session.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if effective_tier(session, current_user) != "pro":
        raise ApiError(403, "PRO_REQUIRED", "개인 에이전트 이용 권한이 필요합니다.")
    if not settings.runtime_provisioning_enabled:
        raise ApiError(
            503, "RUNTIME_NOT_CONFIGURED", "개인 에이전트 자동 배정이 설정되지 않았습니다."
        )
    row = session.get(RuntimeBinding, user.id, with_for_update=True)
    if row is None and str(user.id) in settings.chat_private_runtimes:
        return public_status(current_user, None, settings)
    now = datetime.now(UTC)
    if row is None:
        row = RuntimeBinding(
            user_id=user.id,
            namespace=settings.runtime_namespace,
            resource_name=f"hermes-{user.id.hex}",
            desired="active",
            status="pending",
            generation=1,
            attempts=0,
            encrypted_api_key=encrypt_key(settings),
            next_check_at=now,
            updated_at=now,
        )
        session.add(row)
    elif row.status != "ready":
        # Do not steal a live lease or reactivate while old Pods are draining.
        row.next_check_at = now
    session.commit()
    return public_status(current_user, row, settings)
