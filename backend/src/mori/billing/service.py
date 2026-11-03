import asyncio
import calendar
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from cryptography.fernet import Fernet
from sqlalchemy import or_, select

from mori.auth.models import User
from mori.billing.models import BillingEntitlement, BillingOrder, Checkout, Subscription
from mori.billing.provider import TossClient
from mori.errors import ApiError
from mori.organizer.service import lock_user


def enabled(settings):
    return settings.billing_enabled


def require_enabled(settings):
    if not enabled(settings):
        raise ApiError(503, "BILLING_NOT_CONFIGURED", "결제가 아직 연결되지 않았습니다.")


def cipher(settings):
    return Fernet(settings.billing_encryption_key.get_secret_value().encode())


def month_after(value):
    year, month = value.year + value.month // 12, value.month % 12 + 1
    return value.replace(
        year=year, month=month, day=min(value.day, calendar.monthrange(year, month)[1])
    )


def entitlement(session, user):
    row = session.get(BillingEntitlement, user.id)
    if row is None:
        row = BillingEntitlement(user_id=user.id, admin_granted=user.tier == "pro")
        session.add(row)
        session.flush()
    return row


def effective_tier(session, user, now=None):
    """Authorization read: expiry applies even when the payment worker is unavailable."""
    access = session.get(BillingEntitlement, user.id)
    if access is None:
        return user.tier  # legacy/admin rows are backfilled by the migration
    if access.admin_granted:
        return "pro"
    sub = session.get(Subscription, user.id)
    now = now or datetime.now(UTC)
    return (
        "pro"
        if (
            sub
            and sub.status in {"active", "past_due"}
            and sub.current_period_end
            and sub.current_period_end > now
        )
        else "free"
    )


def refresh_entitlement(session, user, now=None):
    now = now or datetime.now(UTC)
    access = entitlement(session, user)
    subscription = session.get(Subscription, user.id)
    paid = bool(
        subscription
        and subscription.status in {"active", "past_due"}
        and subscription.current_period_end
        and subscription.current_period_end > now
    )
    user.tier = "pro" if access.admin_granted or paid else "free"
    return user.tier


def set_admin_access(session, user, enabled):
    entitlement(session, user).admin_granted = enabled
    return refresh_entitlement(session, user)


def start_checkout(session, user, settings, request_key):
    require_enabled(settings)
    lock_user(session, user.id)
    entitlement(session, user)
    now = datetime.now(UTC)
    previous = session.scalar(
        select(Checkout).where(Checkout.user_id == user.id, Checkout.request_key == request_key)
    )
    if previous:
        if previous.expires_at <= now and not previous.order_id:
            raise ApiError(409, "CHECKOUT_EXPIRED", "결제 요청이 만료됐습니다. 새로 시작해 주세요.")
        return previous
    sub = session.get(Subscription, user.id)
    if sub and sub.current_period_end and sub.current_period_end > now and sub.status == "active":
        raise ApiError(409, "ALREADY_SUBSCRIBED", "이미 구독 중입니다.")
    if session.scalar(
        select(BillingOrder.id).where(
            BillingOrder.user_id == user.id,
            BillingOrder.status.in_(["pending", "processing", "review"]),
        )
    ):
        raise ApiError(409, "BILLING_IN_PROGRESS", "진행 중인 결제 상태를 먼저 확인해 주세요.")
    if sub is None:
        sub = Subscription(
            user_id=user.id,
            customer_key=secrets.token_urlsafe(32),
            amount=settings.billing_pro_amount,
        )
        session.add(sub)
    # Existing canceled/past-due subscribers must explicitly accept the current price again.
    row = Checkout(
        user_id=user.id,
        request_key=request_key,
        amount=settings.billing_pro_amount,
        expires_at=now + timedelta(minutes=15),
    )
    session.add(row)
    session.commit()
    return row


def checkout_read(session, row, settings):
    sub = session.get(Subscription, row.user_id)
    return {
        "id": row.id,
        "provider": "toss",
        "client_key": settings.billing_toss_client_key,
        "customer_key": sub.customer_key,
        "amount": row.amount,
        "currency": "KRW",
        "billing_interval": "month",
        "expires_at": row.expires_at,
        "order_id": row.order_id,
        "success_url": f"{settings.billing_success_url}?checkout_id={row.id}",
        "fail_url": f"{settings.billing_fail_url}?checkout_id={row.id}",
    }


def complete_checkout(session, user, settings, checkout_id, customer_key, auth_key):
    require_enabled(settings)
    lock_user(session, user.id)
    row = session.get(Checkout, checkout_id)
    if row is None or row.user_id != user.id:
        raise ApiError(404, "CHECKOUT_NOT_FOUND", "결제 요청을 찾을 수 없습니다.")
    sub = session.get(Subscription, user.id)
    if not customer_key.isascii() or not secrets.compare_digest(sub.customer_key, customer_key):
        raise ApiError(422, "CHECKOUT_CUSTOMER_MISMATCH", "결제 요청의 사용자가 일치하지 않습니다.")
    if row.order_id:
        return session.get(BillingOrder, row.order_id)
    now = datetime.now(UTC)
    if row.expires_at <= now:
        raise ApiError(409, "CHECKOUT_EXPIRED", "결제 요청이 만료됐습니다.")
    if session.scalar(
        select(BillingOrder.id).where(
            BillingOrder.user_id == user.id,
            BillingOrder.status.in_(["pending", "processing", "review"]),
        )
    ):
        raise ApiError(409, "BILLING_IN_PROGRESS", "진행 중인 결제가 있습니다.")
    if sub.current_period_end and sub.current_period_end > now and sub.status == "active":
        raise ApiError(409, "ALREADY_SUBSCRIBED", "이미 구독 중입니다.")
    sub.amount = row.amount
    order = BillingOrder(
        user_id=user.id,
        amount=row.amount,
        period_start=now,
        period_end=month_after(now),
        auth_key=cipher(settings).encrypt(auth_key.encode()).decode(),
        available_at=now,
    )
    session.add(order)
    session.flush()
    row.order_id = order.id
    sub.status, sub.cancel_at_period_end = "pending", False
    sub.revision += 1
    session.commit()
    return order


def cancel_subscription(session, user, revision, *, resume=False):
    lock_user(session, user.id)
    sub = session.get(Subscription, user.id)
    if sub is None:
        raise ApiError(404, "SUBSCRIPTION_NOT_FOUND", "결제된 구독이 없습니다.")
    if sub.revision != revision:
        raise ApiError(409, "REVISION_CONFLICT", "구독 상태를 다시 조회해 주세요.")
    if session.scalar(
        select(BillingOrder.id).where(
            BillingOrder.user_id == user.id,
            BillingOrder.status.in_(["pending", "processing", "review"]),
        )
    ):
        raise ApiError(409, "BILLING_IN_PROGRESS", "결제 상태 확인 후 구독을 변경해 주세요.")
    if (
        sub.status not in {"active", "past_due"}
        or not sub.current_period_end
        or sub.current_period_end <= datetime.now(UTC)
    ):
        raise ApiError(409, "SUBSCRIPTION_ENDED", "구독 이용 기간이 종료됐습니다.")
    sub.cancel_at_period_end = not resume
    sub.revision += 1
    session.commit()
    return sub


def public_subscription(session, user, settings):
    sub = session.get(Subscription, user.id)
    access = session.get(BillingEntitlement, user.id)
    admin = access.admin_granted if access else user.tier == "pro" and sub is None
    paid = bool(
        sub
        and sub.status == "active"
        and sub.current_period_end
        and sub.current_period_end > datetime.now(UTC)
    )
    processing = (
        session.scalar(
            select(BillingOrder.id)
            .where(
                BillingOrder.user_id == user.id,
                BillingOrder.status.in_(["pending", "processing", "review"]),
            )
            .limit(1)
        )
        is not None
    )
    return {
        "plan": "pro" if admin or paid else "free",
        "access_source": "admin_approval" if admin else "paid_subscription" if paid else "free",
        "billing_status": sub.status if sub else "not_subscribed",
        "checkout_available": enabled(settings) and not paid and not processing,
        "cancellation_available": paid and not sub.cancel_at_period_end,
        "cancel_at_period_end": sub.cancel_at_period_end if sub else False,
        "current_period_end": sub.current_period_end if sub else None,
        "revision": sub.revision if sub else 0,
        "amount": sub.amount if sub else None,
        "message": "구독 종료 예약 후에도 결제된 기간까지 이용할 수 있어요."
        if paid and sub.cancel_at_period_end
        else "결제된 구독을 이용 중이에요."
        if paid
        else "관리자 승인으로 Pro를 이용 중이며 결제된 구독은 없어요."
        if admin
        else "무료로 이용 중이에요.",
    }


def order_read(row):
    return {
        "id": row.id,
        "status": row.status,
        "amount": row.amount,
        "currency": "KRW",
        "created_at": row.created_at,
        "error_code": row.error_code,
    }


def request_verification(session, order_id):
    try:
        parsed = UUID(order_id.removeprefix("mori-"))
    except (ValueError, AttributeError):
        return
    row = session.get(BillingOrder, parsed, with_for_update=True)
    now = datetime.now(UTC)
    if row:
        row.verify_requested = True
        row.available_at = (
            max(now, row.verified_at + timedelta(seconds=30)) if row.verified_at else now
        )
        session.commit()


def enqueue_renewals(factory, now):
    with factory.begin() as session:
        # Consistent user-first locking keeps grant/revoke and cancellation deterministic.
        users = list(
            session.scalars(
                select(User)
                .join(Subscription, Subscription.user_id == User.id)
                .where(Subscription.status == "active", Subscription.current_period_end <= now)
                .order_by(User.id)
                .with_for_update(of=User, skip_locked=True)
                .limit(1000)
            )
        )
        for user in users:
            sub = session.get(Subscription, user.id)
            refresh_entitlement(session, user, now)
            if not sub.current_period_end or sub.current_period_end > now or sub.status != "active":
                continue
            if sub.cancel_at_period_end:
                sub.status = "canceled"
                sub.billing_key = None  # stop future billing; retained token is no longer needed
                sub.revision += 1
                continue
            existing = session.scalar(
                select(BillingOrder).where(
                    BillingOrder.user_id == user.id,
                    BillingOrder.period_start == sub.current_period_end,
                )
            )
            if not existing:
                session.add(
                    BillingOrder(
                        user_id=user.id,
                        amount=sub.amount,
                        period_start=sub.current_period_end,
                        period_end=month_after(sub.current_period_end),
                        available_at=now,
                    )
                )
            sub.status = "past_due"
            sub.revision += 1


@dataclass(frozen=True)
class Claim:
    id: UUID
    user_id: UUID
    token: UUID
    amount: int
    customer_key: str
    billing_key: str | None
    auth_key: str | None
    verify_only: bool
    created_at: datetime


def claim_order(factory, settings, now):
    with factory.begin() as session:
        row = session.scalar(
            select(BillingOrder)
            .where(
                or_(BillingOrder.lease_until.is_(None), BillingOrder.lease_until <= now),
                or_(
                    (BillingOrder.verify_requested.is_(True)) & (BillingOrder.available_at <= now),
                    (BillingOrder.status == "pending") & (BillingOrder.available_at <= now),
                    BillingOrder.lease_until <= now,
                ),
            )
            .order_by(BillingOrder.created_at, BillingOrder.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if not row or row.lease_until and row.lease_until > now:
            return None
        sub = session.get(Subscription, row.user_id)
        if row.status in {"pending", "processing"} and row.attempts >= 3:
            row.status = "review"
            if sub.status == "pending":
                sub.status = "review"
                sub.revision += 1
        verify_only = row.status not in {"pending", "processing"}
        token = uuid4()
        row.lease_token, row.lease_until = (
            token,
            now + timedelta(seconds=settings.billing_lease_seconds),
        )
        row.verify_requested = False
        if not verify_only:
            row.status = "processing"
            row.attempts += 1
        return Claim(
            row.id,
            row.user_id,
            token,
            row.amount,
            sub.customer_key,
            sub.billing_key,
            row.auth_key,
            verify_only,
            row.created_at,
        )


def store_billing_key(factory, claim, token, settings):
    with factory.begin() as session:
        user = session.get(User, claim.user_id, with_for_update=True)
        row = session.get(BillingOrder, claim.id, with_for_update=True)
        if user is None or row.lease_token != claim.token or row.lease_until <= datetime.now(UTC):
            raise ApiError(409, "BILLING_LEASE_LOST", "결제 처리권이 변경됐습니다.")
        sub = session.get(Subscription, user.id)
        sub.billing_key = cipher(settings).encrypt(token.encode()).decode()
        row.auth_key = None


def complete_order(factory, claim, payment):
    if (
        not isinstance(payment, dict)
        or payment.get("orderId") != f"mori-{claim.id}"
        or type(payment.get("totalAmount")) is not int
        or payment["totalAmount"] != claim.amount
        or payment.get("currency") != "KRW"
        or payment.get("type") != "BILLING"
        or not isinstance(payment.get("paymentKey"), str)
        or not 1 <= len(payment["paymentKey"]) <= 200
        or payment.get("status") not in {"DONE", "CANCELED"}
    ):
        raise ApiError(502, "INVALID_BILLING_RESPONSE", "결제 금액과 상태를 확인하지 못했습니다.")
    try:
        approved = datetime.fromisoformat(payment["approvedAt"])
        if approved.tzinfo is None or approved > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError("Invalid approval timestamp")
    except (KeyError, TypeError, ValueError) as exc:
        raise ApiError(
            502, "INVALID_BILLING_RESPONSE", "결제 승인 시각을 확인하지 못했습니다."
        ) from exc
    with factory.begin() as session:
        user = session.get(User, claim.user_id, with_for_update=True)
        row = session.get(BillingOrder, claim.id, with_for_update=True)
        if row.lease_token != claim.token or row.lease_until <= datetime.now(UTC):
            return False
        sub = session.get(Subscription, claim.user_id)
        # A stale/replayed verification must never resurrect an older canceled purchase.
        if row.status == "canceled" and payment["status"] == "DONE":
            row.lease_token = row.lease_until = None
            row.verified_at = datetime.now(UTC)
            return False
        if payment["status"] == "DONE":
            if row.status != "paid" and (
                not sub.current_period_start or sub.current_period_start < approved
            ):
                sub.current_period_start, sub.current_period_end = approved, month_after(approved)
                sub.status = "active"
                sub.revision += 1
            row.status = "paid"
        else:
            # An unconfirmed current charge can already have been refunded before
            # our first successful lookup. Older terminal orders must not cancel a
            # replacement checkout or change its auto-renewal preference.
            if (
                row.status == "paid"
                and sub.status == "active"
                and sub.current_period_start == approved
            ) or (
                row.status in {"pending", "processing", "review"}
                and sub.status in {"pending", "past_due", "review"}
            ):
                sub.status = "canceled"
                sub.cancel_at_period_end = True
                sub.revision += 1
            row.status = "canceled"
        row.payment_key = payment["paymentKey"]
        row.error_code = row.auth_key = row.lease_token = row.lease_until = None
        row.verified_at = datetime.now(UTC)
        refresh_entitlement(session, user)
        return True


def fail_order(factory, claim, code):
    with factory.begin() as session:
        row = session.get(BillingOrder, claim.id, with_for_update=True)
        if row.lease_token != claim.token:
            return
        row.lease_token = row.lease_until = None
        row.error_code = code
        row.verified_at = datetime.now(UTC)
        if claim.verify_only:
            # A webhook remains outstanding until an authoritative lookup succeeds.
            # Consuming its claim must not discard a refund during a provider outage.
            row.verify_requested = True
            row.available_at = datetime.now(UTC) + timedelta(seconds=60)
            return
        if code == "BILLING_PROVIDER_REJECTED":
            row.status, row.auth_key = "failed", None
            sub = session.get(Subscription, claim.user_id)
            if sub.status == "pending":
                sub.status = "failed"
                sub.revision += 1
        elif row.attempts >= 3 or datetime.now(UTC) - row.created_at > timedelta(hours=24):
            row.status = "review"  # ambiguous money movement is never retried with a new order
            sub = session.get(Subscription, claim.user_id)
            if sub.status == "pending":
                sub.status = "review"
                sub.revision += 1
        else:
            row.status = "pending"
            row.available_at = datetime.now(UTC) + timedelta(seconds=30 * 2**row.attempts)


async def run_billing_once(factory, settings, *, transport=None):
    if not enabled(settings):
        return False
    now = datetime.now(UTC)
    await asyncio.to_thread(enqueue_renewals, factory, now)
    claim = await asyncio.to_thread(claim_order, factory, settings, now)
    if claim is None:
        return False
    provider = TossClient(settings, transport)
    try:
        payment = await provider.lookup(claim.id)
        if payment is None:
            if claim.verify_only or datetime.now(UTC) - claim.created_at > timedelta(hours=24):
                raise ApiError(
                    503, "BILLING_RECONCILIATION_REQUIRED", "결제 내역 확인이 필요합니다."
                )
            if claim.auth_key:
                token = await provider.issue(
                    claim.customer_key,
                    cipher(settings).decrypt(claim.auth_key.encode()).decode(),
                    claim.id,
                )
                await asyncio.to_thread(store_billing_key, factory, claim, token, settings)
            elif claim.billing_key:
                token = cipher(settings).decrypt(claim.billing_key.encode()).decode()
            else:
                raise ApiError(502, "BILLING_PROVIDER_REJECTED", "결제 수단을 다시 등록해 주세요.")
            payment = await provider.charge(token, claim.customer_key, claim.id, claim.amount)
        await asyncio.to_thread(complete_order, factory, claim, payment)
    except ApiError as exc:
        await asyncio.to_thread(fail_order, factory, claim, exc.code)
    except Exception:
        await asyncio.to_thread(fail_order, factory, claim, "BILLING_RECONCILIATION_REQUIRED")
    return True
