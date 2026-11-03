"""Reconcile entitlements into isolated, scale-to-zero Hermes installations.

The API only reads encrypted bindings. Kubernetes credentials live in the separate
provisioner. A disabled entitlement denies routing before asynchronous cleanup.
"""

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from cryptography.fernet import Fernet, InvalidToken
from pydantic import SecretStr
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert

from mori.auth.models import User
from mori.billing.models import BillingEntitlement, Subscription
from mori.billing.service import effective_tier
from mori.errors import ApiError
from mori.runtimes.kubernetes import Kubernetes, failure, generation, render
from mori.runtimes.models import RuntimeBinding


def cipher(settings):
    try:
        return Fernet(settings.runtime_master_key.get_secret_value().encode("ascii"))
    except (ValueError, UnicodeError) as exc:
        raise failure("RUNTIME_KEY_NOT_CONFIGURED") from exc


def encrypt_key(settings):
    return cipher(settings).encrypt(secrets.token_urlsafe(48).encode()).decode()


def decrypt_key(settings, encrypted):
    try:
        return cipher(settings).decrypt(encrypted.encode()).decode()
    except (InvalidToken, ValueError, UnicodeError, AttributeError) as exc:
        raise failure("RUNTIME_KEY_UNAVAILABLE") from exc


def resolve_binding(session, settings, user_id, tier):
    """Return the ready managed Runtime, None if unmanaged; never fall back on errors."""
    from mori.chat.runtime import Runtime

    row = session.get(RuntimeBinding, user_id)
    if row is None:
        return None
    # Read entitlement again rather than trusting a caller's previously cached user object.
    user = session.get(User, user_id)
    current_tier = effective_tier(session, user) if user else "free"
    if tier != "pro" or current_tier != "pro":
        raise ApiError(403, "PRO_REQUIRED", "개인 에이전트 이용 권한이 필요합니다.")
    if row.desired != "active" or row.status != "ready" or not row.base_url:
        raise ApiError(503, "RUNTIME_NOT_READY", "개인 에이전트 환경을 준비하고 있습니다.")
    expected = f"http://{row.resource_name}.{row.namespace}.svc.cluster.local"
    if row.base_url != expected:
        raise failure("RUNTIME_ROUTE_INVALID")
    return Runtime(row.base_url, SecretStr(decrypt_key(settings, row.encrypted_api_key)))


def suspend(row, now):
    row.desired = "suspended"
    row.status = "suspending"
    row.generation += 1
    row.encrypted_api_key = None
    row.base_url = None
    row.ready_at = None
    row.attempts = 0
    row.error_code = None
    # Revoke publication immediately, but let an in-flight Kubernetes request finish
    # before another worker starts cleanup. A remote API can still complete a timed-out
    # request later, so suspended bindings also receive periodic cleanup checks.
    row.lease_token = None
    row.updated_at = row.next_check_at = now


def sync_entitlements(factory, settings, now):
    """A durable level-triggered reconciliation; no entitlement event can be lost."""
    manual_users = [UUID(value) for value in getattr(settings, "chat_private_runtimes", {})]
    with factory.begin() as session:
        # A stopped billing loop must not keep expired paid access alive. The provisioner
        # independently checks paid (non-admin) users under the entitlement writer's lock.
        paid_users = session.scalars(
            select(User)
            .join(BillingEntitlement, BillingEntitlement.user_id == User.id)
            .where(
                User.tier == "pro",
                BillingEntitlement.admin_granted.is_(False),
                ~select(Subscription.user_id)
                .where(
                    Subscription.user_id == User.id,
                    Subscription.status.in_(["active", "past_due"]),
                    Subscription.current_period_end > now,
                )
                .exists(),
            )
            .order_by(User.id)
            .limit(100)
            .with_for_update(of=User, skip_locked=True)
        )
        for user in paid_users:
            if effective_tier(session, user, now) != "pro":
                user.tier = "free"
        session.flush()
        missing = session.scalars(
            select(User.id)
            .where(
                User.tier == "pro",
                User.id.not_in(manual_users),
                ~select(RuntimeBinding.user_id).where(RuntimeBinding.user_id == User.id).exists(),
            )
            .order_by(User.id)
            .limit(100)
        )
        for user_id in missing:
            session.execute(
                insert(RuntimeBinding)
                .values(
                    user_id=user_id,
                    id=uuid4(),
                    namespace=settings.runtime_namespace,
                    resource_name=f"hermes-{user_id.hex}",
                    desired="active",
                    status="pending",
                    generation=1,
                    attempts=0,
                    encrypted_api_key=encrypt_key(settings),
                    next_check_at=now,
                    updated_at=now,
                )
                .on_conflict_do_nothing(index_elements=["user_id"])
            )
        changed = session.execute(
            select(RuntimeBinding, User.tier)
            .join(User, User.id == RuntimeBinding.user_id)
            .where(
                or_(
                    (User.tier != "pro") & (RuntimeBinding.desired == "active"),
                    (User.tier == "pro")
                    & (RuntimeBinding.status == "suspended")
                    & or_(RuntimeBinding.lease_until.is_(None), RuntimeBinding.lease_until <= now),
                )
            )
            .order_by(RuntimeBinding.user_id)
            .limit(100)
            .with_for_update(of=RuntimeBinding, skip_locked=True)
        ).all()
        for row, tier in changed:
            if tier != "pro":
                suspend(row, now)
            else:
                # Suspension is fully completed (including Pod drain) before reactivation.
                row.desired, row.status = "active", "pending"
                row.generation += 1
                row.encrypted_api_key = encrypt_key(settings)
                row.base_url = row.ready_at = row.lease_token = row.lease_until = None
                row.error_code, row.attempts = None, 0
                row.updated_at = row.next_check_at = now


@dataclass(frozen=True)
class Claim:
    id: UUID
    user_id: UUID
    namespace: str
    resource_name: str
    desired: str
    generation: int
    token: UUID
    encrypted_api_key: str | None = field(repr=False)


def claim_due(factory, settings, now):
    with factory.begin() as session:
        row = session.scalar(
            select(RuntimeBinding)
            .where(
                RuntimeBinding.next_check_at <= now,
                or_(RuntimeBinding.lease_until.is_(None), RuntimeBinding.lease_until <= now),
            )
            .order_by(RuntimeBinding.next_check_at, RuntimeBinding.user_id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if row is None:
            return None
        user = session.get(User, row.user_id)
        if row.desired == "active" and (
            user is None or effective_tier(session, user, now) != "pro"
        ):
            suspend(row, now)
        row.lease_token = uuid4()
        row.lease_until = now + timedelta(seconds=settings.runtime_lease_seconds)
        row.attempts += 1
        if row.status not in {"ready", "suspended"}:
            row.status = "provisioning" if row.desired == "active" else "suspending"
        row.updated_at = now
        return Claim(
            row.id,
            row.user_id,
            row.namespace,
            row.resource_name,
            row.desired,
            row.generation,
            row.lease_token,
            row.encrypted_api_key,
        )


async def reconcile(kube, claim, settings):
    if claim.namespace != settings.runtime_namespace:
        raise failure("RUNTIME_NAMESPACE_CHANGED")
    if claim.desired == "suspended":
        await kube.delete(claim, "services")
        # Foreground deletion and this explicit drain prevent a re-grant from mounting
        # the previous home while an old Revision is still writing to it.
        if await kube.get(claim, "services") is not None or await kube.pods(claim):
            return "suspending", None, "RUNTIME_TERMINATING"
        await kube.delete(claim, "secrets")
        await kube.delete(claim, "configmaps")
        if (
            await kube.get(claim, "secrets") is not None
            or await kube.get(claim, "configmaps") is not None
        ):
            return "suspending", None, "RUNTIME_TERMINATING"
        # The owned PVC is intentionally retained. Cancellation is not data erasure.
        return "suspended", None, None
    api_key = decrypt_key(settings, claim.encrypted_api_key)
    secret, pvc, config, service = render(claim, settings, api_key)
    existing = await kube.get(claim, "services")
    if existing is not None and generation(existing) < claim.generation:
        # A timed-out old request can reach Kubernetes after suspension. Drain it
        # before reattaching the retained home; never remove newer-generation objects.
        await kube.delete(claim, "services")
        return "provisioning", None, "RUNTIME_TERMINATING"
    if existing is None and await kube.pods(claim):
        return "provisioning", None, "RUNTIME_TERMINATING"
    if existing is None:
        for kind in ("secrets", "configmaps"):
            leftover = await kube.get(claim, kind)
            if leftover is not None and generation(leftover) < claim.generation:
                await kube.delete(claim, kind)
    await kube.ensure(claim, "persistentvolumeclaims", pvc)
    await kube.ensure(claim, "secrets", secret)
    await kube.ensure(claim, "configmaps", config)
    observed = await kube.ensure(claim, "services", service)
    metadata, status = observed.get("metadata", {}), observed.get("status", {})
    ready = any(
        c.get("type") == "Ready" and c.get("status") == "True" for c in status.get("conditions", [])
    )
    if not ready or status.get("observedGeneration") != metadata.get("generation"):
        return "provisioning", None, "RUNTIME_NOT_READY"
    canonical = f"http://{claim.resource_name}.{claim.namespace}.svc.cluster.local"
    if status.get("url") != canonical:
        raise failure("RUNTIME_ROUTE_INVALID")
    return "ready", canonical, None


def finish_claim(factory, settings, claim, result, now):
    with factory.begin() as session:
        # Entitlement writers lock User; read it under the same ordering before publishing.
        user = session.scalar(select(User).where(User.id == claim.user_id).with_for_update())
        row = session.get(RuntimeBinding, claim.user_id, with_for_update=True)
        if (
            row is None
            or row.lease_token != claim.token
            or row.generation != claim.generation
            or row.lease_until is None
            or row.lease_until <= now
        ):
            return False
        if claim.desired == "active" and (
            user is None or effective_tier(session, user, now) != "pro"
        ):
            suspend(row, now)
            return False
        status, url, error = result
        row.status, row.base_url, row.error_code = status, url, error
        row.lease_token = row.lease_until = None
        row.updated_at = now
        if status == "ready":
            row.ready_at = row.ready_at or now
            row.attempts = 0
        elif status == "suspended":
            row.encrypted_api_key = row.base_url = row.ready_at = None
            row.attempts = 0
        if status == "suspended":
            delay = 300
        elif status == "retry":
            delay = min(300, 10 * 2 ** min(row.attempts, 5))
        else:
            delay = settings.runtime_poll_seconds
        row.next_check_at = now + timedelta(seconds=delay)
        return True


async def process_once(factory, settings, *, transport=None, now=None):
    if not settings.runtime_provisioning_enabled:
        return False
    instant = now or datetime.now(UTC)
    await asyncio.to_thread(sync_entitlements, factory, settings, instant)
    claim = await asyncio.to_thread(claim_due, factory, settings, instant)
    if claim is None:
        return False
    try:
        # Finish the HTTP sequence before another worker can take the expired claim.
        async with asyncio.timeout(settings.runtime_lease_seconds - 30):
            async with Kubernetes(settings, transport) as kube:
                result = await reconcile(kube, claim, settings)
    except Exception as exc:
        # Kubernetes error bodies may contain object data; never store or expose them.
        result = (
            "retry" if claim.desired == "active" else "suspending",
            None,
            exc.code if isinstance(exc, ApiError) else "RUNTIME_CLUSTER_UNAVAILABLE",
        )
    await asyncio.to_thread(
        finish_claim, factory, settings, claim, result, now or datetime.now(UTC)
    )
    return True


async def prewarm(factory, settings, user_id, *, transport=None):
    """Wake an already assigned route without model inference or scheduler ownership."""

    def binding():
        with factory() as session:
            user = session.get(User, user_id)
            if user is None:
                raise ApiError(404, "USER_NOT_FOUND", "사용자를 찾을 수 없습니다.")
            runtime = resolve_binding(session, settings, user_id, user.tier)
            if runtime is None:
                raise ApiError(
                    503, "RUNTIME_NOT_READY", "개인 에이전트가 아직 배정되지 않았습니다."
                )
            return runtime

    runtime = await asyncio.to_thread(binding)
    async with httpx.AsyncClient(
        transport=transport, trust_env=False, follow_redirects=False
    ) as client:
        response = await client.get(
            runtime.url + "/v1/toolsets",
            headers={"Authorization": "Bearer " + runtime.key.get_secret_value()},
            timeout=settings.hermes_startup_timeout_seconds,
        )
        if response.status_code != 200:
            raise failure("RUNTIME_PREWARM_FAILED")
    return True
