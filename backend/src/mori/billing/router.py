from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query, Request
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.billing import service
from mori.billing.models import BillingOrder
from mori.billing.schemas import CheckoutComplete, CheckoutRead, OrderRead, PaymentWebhook
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.organizer.schemas import Revision

router = APIRouter(prefix="/v1/billing", tags=["billing"], responses=PRIVATE_API_RESPONSES)


@router.post("/checkouts", response_model=CheckoutRead, status_code=201)
def checkout(
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    row = service.start_checkout(session, user, request.app.state.settings, idempotency_key)
    return service.checkout_read(session, row, request.app.state.settings)


@router.post("/checkouts/{checkout_id}/complete", response_model=OrderRead, status_code=202)
def complete(
    checkout_id: UUID,
    payload: CheckoutComplete,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    order = service.complete_checkout(
        session,
        user,
        request.app.state.settings,
        checkout_id,
        payload.customer_key,
        payload.auth_key,
    )
    return service.order_read(order)


@router.get("/orders/{order_id}", response_model=OrderRead)
def order(order_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = session.scalar(
        select(BillingOrder).where(BillingOrder.id == order_id, BillingOrder.user_id == user.id)
    )
    if row is None:
        raise ApiError(404, "BILLING_ORDER_NOT_FOUND", "결제 내역을 찾을 수 없습니다.")
    return service.order_read(row)


@router.get("/orders", response_model=list[OrderRead])
def orders(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    rows = session.scalars(
        select(BillingOrder)
        .where(BillingOrder.user_id == user.id)
        .order_by(BillingOrder.created_at.desc(), BillingOrder.id)
        .limit(limit)
        .offset(offset)
    )
    return [service.order_read(row) for row in rows]


@router.post("/orders/{order_id}/reconcile", response_model=OrderRead, status_code=202)
def reconcile(order_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = session.scalar(
        select(BillingOrder).where(BillingOrder.id == order_id, BillingOrder.user_id == user.id)
    )
    if row is None:
        raise ApiError(404, "BILLING_ORDER_NOT_FOUND", "결제 내역을 찾을 수 없습니다.")
    service.request_verification(session, f"mori-{order_id}")
    return service.order_read(row)


@router.post("/subscription/cancel")
def cancel(payload: Revision, user: CurrentUser, session: DatabaseSession, request: Request):
    service.cancel_subscription(session, user, payload.revision)
    return service.public_subscription(session, user, request.app.state.settings)


@router.post("/subscription/resume")
def resume(payload: Revision, user: CurrentUser, session: DatabaseSession, request: Request):
    service.require_enabled(request.app.state.settings)
    service.cancel_subscription(session, user, payload.revision, resume=True)
    return service.public_subscription(session, user, request.app.state.settings)


@router.post("/webhooks/toss", status_code=202)
def webhook(payload: PaymentWebhook, session: DatabaseSession):
    # This notification is untrusted. It only schedules a server-authenticated lookup of
    # an already known order; no payload status, amount or user identity can grant access.
    service.request_verification(session, payload.data.orderId)
    return {"accepted": True}
