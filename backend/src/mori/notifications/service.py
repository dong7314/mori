"""Durable, leased Web Push dispatch. Provider acceptance is not an OS delivery receipt."""

import hashlib
import ipaddress
import json
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from mori.errors import ApiError
from mori.notifications.models import PushSubscription, ReminderDelivery
from mori.notifications.schemas import decode_key, validate_endpoint, validate_public_key
from mori.organizer.models import Reminder
from mori.organizer.service import lock_user


def validate_allowed_hosts(hosts):
    if not hosts or len(set(hosts)) != len(hosts):
        raise ValueError("Specify unique push provider hostnames")
    for host in hosts:
        if (
            host != host.lower()
            or len(host) > 253
            or not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}", host)
            or host.endswith((".localhost", ".local", ".internal"))
        ):
            raise ValueError("Push providers must use explicit public hostnames without wildcards")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            continue
        raise ValueError("Push providers must not be IP literals")
    return hosts


def validate_allowed_endpoint(endpoint, hosts):
    validate_endpoint(endpoint)
    validate_allowed_hosts(hosts)
    if urlsplit(endpoint).hostname not in hosts:
        raise ValueError("Push endpoint host is not allowed")
    return endpoint


def validate_push_configuration(settings):
    validate_allowed_hosts(settings.push_allowed_hosts)
    if not settings.push_enabled:
        return False
    validate_public_key(settings.vapid_public_key)
    raw_private = decode_key(settings.vapid_private_key.get_secret_value())
    if len(raw_private) == 32:
        private = ec.derive_private_key(int.from_bytes(raw_private), ec.SECP256R1())
    else:
        private = serialization.load_der_private_key(raw_private, password=None)
    if not isinstance(private, ec.EllipticCurvePrivateKey) or not isinstance(
        private.curve, ec.SECP256R1
    ):
        raise ValueError("VAPID private key must use P-256")
    public = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    if public != decode_key(settings.vapid_public_key):
        raise ValueError("VAPID public/private keys do not match")
    subject = settings.vapid_subject
    parsed = urlsplit(subject)
    if any(ord(char) <= 32 or ord(char) == 127 for char in subject) or "\\" in subject:
        raise ValueError("Invalid VAPID subject")
    if not re.fullmatch(r"mailto:[^@\s]+@[^@\s]+\.[^@\s]+", subject) and not (
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.username is None
        and parsed.password is None
        and not parsed.fragment
    ):
        raise ValueError("VAPID subject must be a mailto contact or HTTPS URL")
    if settings.push_lease_seconds <= 2 * settings.push_timeout_seconds:
        raise ValueError("Push lease must exceed twice the provider timeout")
    return True


def register_subscription(session, user_id, payload, settings):
    if not validate_push_configuration(settings):
        raise ApiError(503, "PUSH_NOT_CONFIGURED", "기기 알림 연결을 준비하고 있어요.")
    try:
        validate_allowed_endpoint(payload.endpoint, settings.push_allowed_hosts)
    except ValueError as exc:
        raise ApiError(
            422, "PUSH_ENDPOINT_NOT_ALLOWED", "지원하는 알림 서비스 주소가 아닙니다."
        ) from exc
    lock_user(session, user_id)
    digest = hashlib.sha256(payload.endpoint.encode()).hexdigest()
    existing = session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint_hash == digest).with_for_update()
    )
    if existing is not None and existing.user_id != user_id:
        raise ApiError(409, "SUBSCRIPTION_CONFLICT", "다른 계정에 연결된 기기 알림입니다.")
    active_count = session.scalar(
        select(func.count())
        .select_from(PushSubscription)
        .where(PushSubscription.user_id == user_id, PushSubscription.active.is_(True))
    )
    if active_count >= 20 and (existing is None or not existing.active):
        raise ApiError(409, "SUBSCRIPTION_LIMIT", "기기 알림 연결은 계정당 20개까지 가능합니다.")
    now = datetime.now(UTC)
    if existing is None:
        existing = session.scalar(
            insert(PushSubscription)
            .values(
                id=uuid4(),
                user_id=user_id,
                endpoint=payload.endpoint,
                endpoint_hash=digest,
                p256dh=payload.keys.p256dh,
                auth=payload.keys.auth,
                device_name=payload.device_name,
                active=True,
                activated_at=now,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(constraint="uq_push_endpoint_hash")
            .returning(PushSubscription)
        )
        if existing is None:
            raise ApiError(409, "SUBSCRIPTION_CONFLICT", "이미 연결된 기기 알림입니다.")
    else:
        if not existing.active:
            existing.activated_at = now
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
        existing.device_name = payload.device_name
        existing.active = True
        existing.updated_at = now
    session.commit()
    return existing


def enqueue_due(factory, now, limit=200):
    """Insert once per reminder target/device; newly subscribed devices do not get old timers."""
    queued = 0
    with factory.begin() as session:
        already_queued = (
            select(ReminderDelivery.id)
            .where(
                ReminderDelivery.reminder_id == Reminder.id,
                ReminderDelivery.subscription_id == PushSubscription.id,
                ReminderDelivery.target_at == Reminder.target_at,
            )
            .exists()
        )
        due = session.execute(
            select(Reminder.id, Reminder.user_id, Reminder.target_at, PushSubscription.id)
            .join(PushSubscription, PushSubscription.user_id == Reminder.user_id)
            .where(
                Reminder.deleted_at.is_(None),
                Reminder.cancelled.is_(False),
                Reminder.target_at <= now,
                PushSubscription.active.is_(True),
                PushSubscription.activated_at <= Reminder.target_at,
                ~already_queued,
            )
            .order_by(Reminder.target_at, Reminder.id, PushSubscription.id)
            .limit(limit)
        )
        for reminder_id, user_id, target_at, subscription_id in due:
            inserted = session.scalar(
                insert(ReminderDelivery)
                .values(
                    id=uuid4(),
                    user_id=user_id,
                    reminder_id=reminder_id,
                    subscription_id=subscription_id,
                    target_at=target_at,
                    next_attempt_at=target_at,
                )
                .on_conflict_do_nothing(constraint="uq_reminder_delivery_target")
                .returning(ReminderDelivery.id)
            )
            queued += inserted is not None
    return queued


def _claim_one(factory, settings, now):
    with factory.begin() as session:
        row = session.scalar(
            select(ReminderDelivery)
            .where(
                ReminderDelivery.attempts < settings.push_max_attempts,
                or_(
                    and_(
                        ReminderDelivery.status.in_(("queued", "retry")),
                        ReminderDelivery.next_attempt_at <= now,
                    ),
                    and_(
                        ReminderDelivery.status == "processing",
                        ReminderDelivery.lease_until <= now,
                    ),
                ),
            )
            .order_by(ReminderDelivery.next_attempt_at, ReminderDelivery.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if row is None:
            return None
        row.status = "processing"
        row.attempts += 1
        row.lease_token = uuid4()
        row.lease_until = now + timedelta(seconds=settings.push_lease_seconds)
        row.updated_at = now
        return row.id, row.lease_token


def send_webpush(**kwargs):
    """Use the official encryption/VAPID implementation with redirects disabled."""
    import requests
    from pywebpush import webpush

    class NoRedirectSession(requests.Session):
        def request(self, method, url, **options):
            options["allow_redirects"] = False
            return super().request(method, url, **options)

    with NoRedirectSession() as http:
        http.trust_env = False
        return webpush(**kwargs, requests_session=http)


def _provider_status(error):
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def _send_claim(factory, settings, claim, now, sender):
    delivery_id, token = claim
    with factory.begin() as session:
        row = session.get(ReminderDelivery, delivery_id, with_for_update=True)
        if (
            row is None
            or row.status != "processing"
            or row.lease_token != token
            or row.lease_until is None
            or row.lease_until <= now
        ):
            return "skipped"
        # Keep domain/subscription locks through the bounded network call: cancellation,
        # rescheduling and unsubscribe commit either before this check or after dispatch.
        reminder = session.get(Reminder, row.reminder_id, with_for_update=True)
        subscription = session.get(PushSubscription, row.subscription_id, with_for_update=True)
        reason = None
        if reminder is None or reminder.deleted_at is not None:
            reason = "REMINDER_DELETED"
        elif reminder.cancelled:
            reason = "REMINDER_CANCELLED"
        elif reminder.target_at != row.target_at:
            reason = "TARGET_CHANGED"
        elif subscription is None or not subscription.active:
            reason = "SUBSCRIPTION_INACTIVE"
        elif subscription.activated_at > row.target_at:
            reason = "SUBSCRIPTION_REACTIVATED"
        elif reminder.user_id != row.user_id or subscription.user_id != row.user_id:
            reason = "OWNER_MISMATCH"
        if reason is None:
            try:
                validate_allowed_endpoint(subscription.endpoint, settings.push_allowed_hosts)
            except ValueError:
                reason = "PUSH_ENDPOINT_NOT_ALLOWED"
        row.updated_at = now
        row.lease_token = None
        row.lease_until = None
        if reason:
            row.status = "skipped"
            row.last_error_code = reason
            return row.status

        tag = f"mori-reminder-{reminder.id}-{int(row.target_at.timestamp() * 1_000_000)}"
        data = json.dumps(
            {
                "type": "reminder",
                "reminder_id": str(reminder.id),
                "delivery_id": str(row.id),
                "title": reminder.title,
                "target_at": row.target_at.isoformat(),
                "tag": tag,
                "url": "/",
            },
            ensure_ascii=False,
        )
        try:
            response = sender(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                },
                data=data,
                vapid_private_key=settings.vapid_private_key.get_secret_value(),
                vapid_claims={"sub": settings.vapid_subject},
                timeout=settings.push_timeout_seconds,
                ttl=300,
                headers={"Topic": hashlib.sha256(tag.encode()).hexdigest()[:32]},
            )
            status = _provider_status(response)
        except Exception as exc:
            # Never persist exception text: providers may echo endpoints, tokens or payloads.
            status = _provider_status(exc)
        row.provider_status = status
        if status in (200, 201, 202):
            row.status = "sent"
            row.sent_at = now
            row.last_error_code = None
        elif status in (404, 410):
            subscription.active = False
            subscription.updated_at = now
            row.status = "failed"
            row.last_error_code = "SUBSCRIPTION_GONE"
        elif status is not None and 300 <= status < 500 and status != 429:
            row.status = "failed"
            row.last_error_code = "PUSH_REJECTED"
        elif row.attempts >= settings.push_max_attempts:
            row.status = "failed"
            row.last_error_code = "ATTEMPTS_EXHAUSTED"
        else:
            row.status = "retry"
            row.last_error_code = "PROVIDER_UNAVAILABLE"
            row.next_attempt_at = now + timedelta(seconds=min(30 * 2 ** (row.attempts - 1), 900))
        return row.status


def deliver_due(factory, settings, now=None, sender=None):
    """Bounded worker tick. A crash after provider acceptance may retry with the same tag."""
    summary = {
        "enabled": False,
        "queued": 0,
        "processed": 0,
        "sent": 0,
        "retry": 0,
        "failed": 0,
        "skipped": 0,
    }
    if not validate_push_configuration(settings):
        return summary
    if now is not None and (now.tzinfo is None or now.utcoffset() is None):
        raise ValueError("Worker time must include a timezone")
    current = now or datetime.now(UTC)
    summary["enabled"] = True
    summary["queued"] = enqueue_due(factory, current)
    with factory.begin() as session:
        expired = session.execute(
            update(ReminderDelivery)
            .where(
                ReminderDelivery.status == "processing",
                ReminderDelivery.lease_until <= current,
                ReminderDelivery.attempts >= settings.push_max_attempts,
            )
            .values(
                status="failed",
                last_error_code="ATTEMPTS_EXHAUSTED",
                lease_token=None,
                lease_until=None,
                updated_at=current,
            )
        )
        summary["failed"] += expired.rowcount
    for _ in range(100):
        current = now or datetime.now(UTC)
        claim = _claim_one(factory, settings, current)
        if claim is None:
            break
        status = _send_claim(factory, settings, claim, current, sender or send_webpush)
        summary["processed"] += 1
        summary[status] += 1
    return summary
