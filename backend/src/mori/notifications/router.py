from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Query, Request
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.notifications.models import PushSubscription, ReminderDelivery
from mori.notifications.schemas import (
    DeliveryRead,
    PushConfigRead,
    SubscriptionRead,
    SubscriptionWrite,
)
from mori.notifications.service import register_subscription, validate_push_configuration
from mori.organizer.models import Reminder
from mori.organizer.service import owned

router = APIRouter(prefix="/v1", tags=["notifications"], responses=PRIVATE_API_RESPONSES)


@router.get("/notifications/push-config", response_model=PushConfigRead)
def push_config(request: Request):
    settings = request.app.state.settings
    enabled = validate_push_configuration(settings)
    return {"enabled": enabled, "public_key": settings.vapid_public_key if enabled else None}


@router.post("/notifications/subscriptions", response_model=SubscriptionRead, status_code=201)
def subscribe(
    payload: SubscriptionWrite, user: CurrentUser, session: DatabaseSession, request: Request
):
    return register_subscription(session, user.id, payload, request.app.state.settings)


@router.get("/notifications/subscriptions", response_model=list[SubscriptionRead])
def subscriptions(user: CurrentUser, session: DatabaseSession):
    return list(
        session.scalars(
            select(PushSubscription)
            .where(PushSubscription.user_id == user.id)
            .order_by(PushSubscription.updated_at.desc(), PushSubscription.id)
            .limit(100)
        )
    )


@router.delete("/notifications/subscriptions/{subscription_id}", response_model=SubscriptionRead)
def unsubscribe(subscription_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = session.scalar(
        select(PushSubscription)
        .where(PushSubscription.id == subscription_id, PushSubscription.user_id == user.id)
        .with_for_update()
    )
    if row is None:
        raise ApiError(404, "SUBSCRIPTION_NOT_FOUND", "기기 알림 연결을 찾을 수 없습니다.")
    row.active = False
    row.updated_at = datetime.now(UTC)
    session.commit()
    return row


@router.get("/reminders/{reminder_id}/deliveries", response_model=list[DeliveryRead])
def reminder_deliveries(
    reminder_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    owned(session, Reminder, user.id, reminder_id)
    return list(
        session.scalars(
            select(ReminderDelivery)
            .where(ReminderDelivery.user_id == user.id, ReminderDelivery.reminder_id == reminder_id)
            .order_by(ReminderDelivery.target_at.desc(), ReminderDelivery.id)
            .offset(offset)
            .limit(limit)
        )
    )
