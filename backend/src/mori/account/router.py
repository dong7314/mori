from fastapi import APIRouter, Request
from sqlalchemy import select

from mori.account.models import AccountSettings
from mori.account.schemas import PlanRead, SettingsRead, SettingsWrite, SubscriptionRead
from mori.auth.dependencies import CurrentUser
from mori.billing.service import public_subscription
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.organizer.service import lock_user

router = APIRouter(tags=["account"], responses=PRIVATE_API_RESPONSES)


@router.get("/v1/me/settings", response_model=SettingsRead, summary="내 테마 설정")
def settings(user: CurrentUser, session: DatabaseSession):
    row = session.get(AccountSettings, user.id)
    return SettingsRead(theme=row.theme if row else "system", revision=row.revision if row else 0)


@router.put("/v1/me/settings", response_model=SettingsRead, summary="내 테마 변경")
def update_settings(payload: SettingsWrite, user: CurrentUser, session: DatabaseSession):
    lock_user(session, user.id)
    row = session.scalar(select(AccountSettings).where(AccountSettings.user_id == user.id))
    if payload.revision != (row.revision if row else 0):
        raise ApiError(409, "REVISION_CONFLICT", "설정이 변경됐어요. 다시 조회해 주세요.")
    if row is None:
        row = AccountSettings(user_id=user.id, theme=payload.theme, revision=1)
        session.add(row)
    else:
        row.theme = payload.theme
        row.revision += 1
    session.commit()
    return SettingsRead(theme=row.theme, revision=row.revision)


@router.get("/v1/plans", response_model=list[PlanRead], summary="무료·Pro 요금제 안내")
def plans(request: Request):
    settings = request.app.state.settings
    # No price, checkout URL, or paid entitlement is invented before a provider is configured.
    return [
        PlanRead(
            id="free",
            name="Free",
            description="결제 없이 시작하는 모리",
            amount=0,
            status="available",
        ),
        PlanRead(
            id="pro",
            name="Pro",
            description="개인 비서 환경을 위한 요금제"
            if settings.billing_enabled
            else "개인 비서 환경을 위한 요금제 · 준비 중",
            amount=settings.billing_pro_amount if settings.billing_enabled else None,
            billing_interval="month" if settings.billing_enabled else None,
            checkout_available=settings.billing_enabled,
            status="available" if settings.billing_enabled else "coming_soon",
        ),
    ]


@router.get("/v1/me/subscription", response_model=SubscriptionRead, summary="내 요금제와 결제 상태")
def subscription(user: CurrentUser, session: DatabaseSession, request: Request):
    return public_subscription(session, user, request.app.state.settings)
