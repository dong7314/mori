import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr
from sqlalchemy import func, select

from mori.auth.models import User
from mori.billing import service
from mori.billing.models import BillingOrder, Subscription


@pytest.fixture
def billing(client):
    settings = client.app.state.settings
    settings.billing_enabled = True
    settings.billing_toss_secret_key = SecretStr("test_sk_server_only")
    settings.billing_toss_client_key = "test_ck_public"
    settings.billing_encryption_key = SecretStr(Fernet.generate_key().decode())
    settings.billing_pro_amount = 12000
    settings.billing_success_url = "https://app.test/billing/success"
    settings.billing_fail_url = "https://app.test/billing/fail"
    return settings


def checkout(client, accounts):
    headers = {**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())}
    response = client.post("/v1/billing/checkouts", headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def queued_order(client, accounts):
    draft = checkout(client, accounts)
    payload = {"customer_key": draft["customer_key"], "auth_key": "private-one-time-auth-key"}
    response = client.post(
        f"/v1/billing/checkouts/{draft['id']}/complete",
        headers=accounts["alice"]["headers"],
        json=payload,
    )
    assert response.status_code == 202, response.text
    assert "private-one-time-auth-key" not in response.text
    return draft, response.json(), payload


def payment(order, **overrides):
    return {
        "orderId": "mori-" + order["id"],
        "paymentKey": "private-payment-key",
        "type": "BILLING",
        "currency": "KRW",
        "totalAmount": 12000,
        "status": "DONE",
        "approvedAt": datetime.now(UTC).isoformat(),
        **overrides,
    }


def provider(order, customer, *, paid=False, override=None):
    calls = []
    approved = payment(order, **(override or {}))

    def handle(request):
        calls.append(request)
        assert request.url.host == "api.tosspayments.com"
        assert request.headers["authorization"].startswith("Basic ")
        if request.method == "GET":
            return (
                httpx.Response(200, json=approved)
                if paid
                else httpx.Response(404, json={"code": "NOT_FOUND_PAYMENT"})
            )
        if request.url.path.endswith("/authorizations/issue"):
            assert json.loads(request.content)["customerKey"] == customer
            return httpx.Response(
                200, json={"customerKey": customer, "billingKey": "private-billing-key"}
            )
        assert request.headers["Idempotency-Key"] == "charge-" + order["id"]
        assert json.loads(request.content)["amount"] == 12000
        return httpx.Response(200, json=approved)

    return httpx.MockTransport(handle), calls, approved


def test_unconfigured_checkout_cannot_create_entitlement(client, accounts):
    result = client.post(
        "/v1/billing/checkouts",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
    )
    assert result.status_code == 503
    assert result.json()["error"]["code"] == "BILLING_NOT_CONFIGURED"
    assert client.get("/v1/me", headers=accounts["alice"]["headers"]).json()["tier"] == "free"


def test_checkout_bound_to_owner_customer_and_idempotent(client, accounts, billing, sessions):
    key = str(uuid4())
    headers = {**accounts["alice"]["headers"], "Idempotency-Key": key}
    first = client.post("/v1/billing/checkouts", headers=headers).json()
    assert first == client.post("/v1/billing/checkouts", headers=headers).json()
    path = f"/v1/billing/checkouts/{first['id']}/complete"
    payload = {"customer_key": first["customer_key"], "auth_key": "secret-auth"}
    assert client.post(path, headers=accounts["bob"]["headers"], json=payload).status_code == 404
    assert (
        client.post(
            path, headers=accounts["alice"]["headers"], json={**payload, "customer_key": "other"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            path, headers=accounts["alice"]["headers"], json={**payload, "amount": 1}
        ).status_code
        == 422
    )
    order = client.post(path, headers=accounts["alice"]["headers"], json=payload).json()
    assert order == client.post(path, headers=accounts["alice"]["headers"], json=payload).json()
    assert (
        client.get(
            f"/v1/billing/orders/{order['id']}", headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(BillingOrder)) == 1
        assert "secret-auth" not in session.get(BillingOrder, UUID(order["id"])).auth_key


def test_verified_payment_grants_pro_and_encrypts_billing_token(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)
    transport, calls, _ = provider(order, draft["customer_key"])
    assert asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    assert len(calls) == 3
    result = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert result["billing_status"] == "active"
    assert result["access_source"] == "paid_subscription" and result["plan"] == "pro"
    assert result["cancellation_available"]
    assert "private-billing-key" not in json.dumps(result)
    with sessions() as session:
        assert (
            session.get(Subscription, accounts["alice"]["user_id"]).billing_key
            != "private-billing-key"
        )
        assert session.get(User, accounts["alice"]["user_id"]).tier == "pro"


@pytest.mark.parametrize(
    "override",
    [{"totalAmount": 1}, {"orderId": "someone-else"}, {"currency": "USD"}, {"type": "NORMAL"}],
)
def test_invalid_provider_payment_never_grants_access(
    client, accounts, billing, sessions, override
):
    draft, order, _ = queued_order(client, accounts)
    transport, _, _ = provider(order, draft["customer_key"], paid=True, override=override)
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    with sessions() as session:
        assert session.get(User, accounts["alice"]["user_id"]).tier == "free"
        assert session.get(BillingOrder, UUID(order["id"])).status != "paid"


@pytest.mark.parametrize("lookup_denied", [None, 401, 403])
def test_retry_checks_existing_payment_before_charging_again(
    client, accounts, billing, sessions, lookup_denied
):
    draft, order, _ = queued_order(client, accounts)
    approved = payment(order)
    calls = []

    def ambiguous(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(404)
        if request.url.path.endswith("/issue"):
            return httpx.Response(
                200, json={"customerKey": draft["customer_key"], "billingKey": "saved-token"}
            )
        raise httpx.ReadTimeout("Provider accepted; reply was lost")

    asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(ambiguous))
    )
    with sessions.begin() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        assert row.status == "pending"
        row.available_at = datetime.now(UTC) - timedelta(seconds=1)

    if lookup_denied is not None:
        # Losing API access cannot prove that the previous charge was rejected.
        def denied(request):
            calls.append(request)
            assert request.method == "GET"
            return httpx.Response(lookup_denied, json={"code": "UNAUTHORIZED_KEY"})

        asyncio.run(
            service.run_billing_once(sessions, billing, transport=httpx.MockTransport(denied))
        )
        with sessions.begin() as session:
            row = session.get(BillingOrder, UUID(order["id"]))
            assert row.status == "pending"
            row.available_at = datetime.now(UTC) - timedelta(seconds=1)
        headers = accounts["alice"]["headers"]
        assert not client.get("/v1/me/subscription", headers=headers).json()["checkout_available"]
        assert (
            client.post(
                "/v1/billing/checkouts", headers={**headers, "Idempotency-Key": str(uuid4())}
            ).status_code
            == 409
        )

    def recovered(request):
        calls.append(request)
        assert request.method == "GET"
        return httpx.Response(200, json=approved)

    asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(recovered))
    )
    assert (
        sum(
            request.method == "POST" and not request.url.path.endswith("/issue")
            for request in calls
        )
        == 1
    )
    assert (
        client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()["plan"]
        == "pro"
    )


def test_webhook_is_only_a_notification_and_refetch_preserves_admin_access(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)
    transport, _, approved = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    user_id = accounts["alice"]["user_id"]
    with sessions.begin() as session:
        service.set_admin_access(session, session.get(User, user_id), True)
        row = session.get(BillingOrder, UUID(order["id"]))
        row.verified_at = datetime.now(UTC) - timedelta(minutes=1)
    assert (
        client.post(
            "/v1/billing/webhooks/toss",
            json={
                "eventType": "PAYMENT_STATUS_CHANGED",
                "data": {"orderId": "mori-" + order["id"], "status": "CANCELED"},
            },
        ).status_code
        == 202
    )
    # Unauthenticated body cannot revoke or grant anything until provider verification.
    assert (
        client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()[
            "billing_status"
        ]
        == "active"
    )

    def verified_cancel(request):
        assert request.method == "GET"
        return httpx.Response(200, json={**approved, "status": "CANCELED"})

    asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(verified_cancel))
    )
    result = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert result["billing_status"] == "canceled" and result["plan"] == "pro"
    assert result["access_source"] == "admin_approval"


def test_rejected_charge_allows_new_checkout_without_granting_access(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)

    def rejected(request):
        if request.method == "GET":
            return httpx.Response(404)
        if request.url.path.endswith("/issue"):
            return httpx.Response(
                200, json={"customerKey": draft["customer_key"], "billingKey": "saved-token"}
            )
        return httpx.Response(400, json={"code": "REJECT_CARD_COMPANY"})

    assert asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(rejected))
    )
    with sessions() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        assert row.status == "failed" and row.error_code == "BILLING_PROVIDER_REJECTED"
    result = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert result["checkout_available"] and result["plan"] == "free"


def test_period_end_cancel_stops_renewal_and_expiration_removes_only_paid_access(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)
    transport, _, _ = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    headers = accounts["alice"]["headers"]
    old = client.get("/v1/me/subscription", headers=headers).json()
    response = client.post(
        "/v1/billing/subscription/cancel", headers=headers, json={"revision": old["revision"]}
    )
    assert response.status_code == 200 and response.json()["plan"] == "pro"
    assert response.json()["cancel_at_period_end"]
    assert (
        client.post(
            "/v1/billing/subscription/resume", headers=headers, json={"revision": old["revision"]}
        ).status_code
        == 409
    )
    with sessions() as session:
        end = session.get(Subscription, accounts["alice"]["user_id"]).current_period_end
    service.enqueue_renewals(sessions, end + timedelta(seconds=1))
    with sessions() as session:
        assert session.get(User, accounts["alice"]["user_id"]).tier == "free"
        assert session.get(Subscription, accounts["alice"]["user_id"]).status == "canceled"
        assert session.scalar(select(func.count()).select_from(BillingOrder)) == 1


def test_claim_excludes_other_workers_and_renewal_amount_is_price_snapshot(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)
    now = datetime.now(UTC)
    claim = service.claim_order(sessions, billing, now)
    assert claim.id == UUID(order["id"])
    assert service.claim_order(sessions, billing, now) is None
    service.complete_order(sessions, claim, payment(order))
    billing.billing_pro_amount = 99999
    with sessions() as session:
        end = session.get(Subscription, accounts["alice"]["user_id"]).current_period_end
    service.enqueue_renewals(sessions, end + timedelta(seconds=1))
    service.enqueue_renewals(sessions, end + timedelta(seconds=1))
    with sessions() as session:
        rows = list(session.scalars(select(BillingOrder).where(BillingOrder.period_start == end)))
        assert len(rows) == 1 and rows[0].amount == 12000


def test_checkout_price_is_immutable_and_expiry_checks_do_not_mutate_user(
    client, accounts, billing, sessions
):
    draft = checkout(client, accounts)
    billing.billing_pro_amount = 24000
    checkout(client, accounts)
    response = client.post(
        f"/v1/billing/checkouts/{draft['id']}/complete",
        headers=accounts["alice"]["headers"],
        json={"customer_key": draft["customer_key"], "auth_key": "auth"},
    )
    order = response.json()
    assert order["amount"] == 12000
    transport, _, _ = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    with sessions() as session:
        user = session.get(User, accounts["alice"]["user_id"])
        sub = session.get(Subscription, user.id)
        assert (
            service.effective_tier(session, user, sub.current_period_end + timedelta(seconds=1))
            == "free"
        )
        assert user.tier == "pro" and not session.dirty


def test_last_attempt_crash_is_lookup_only_after_lease_expires(client, accounts, billing, sessions):
    draft, order, _ = queued_order(client, accounts)
    with sessions.begin() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        row.status, row.attempts = "processing", 3
        row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    methods = []

    def lookup_only(request):
        methods.append(request.method)
        return httpx.Response(404)

    asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(lookup_only))
    )
    assert methods == ["GET"]
    with sessions() as session:
        assert session.get(BillingOrder, UUID(order["id"])).status == "review"
        assert session.get(Subscription, accounts["alice"]["user_id"]).status == "review"
    result = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert result["billing_status"] == "review" and not result["checkout_available"]


def test_checkout_availability_tracks_orders_not_abandoned_checkout(
    client, accounts, billing, sessions
):
    headers = accounts["alice"]["headers"]
    checkout(client, accounts)
    # An abandoned payment form must not prevent the user from starting again.
    assert client.get("/v1/me/subscription", headers=headers).json()["checkout_available"]
    _, order, _ = queued_order(client, accounts)
    assert not client.get("/v1/me/subscription", headers=headers).json()["checkout_available"]
    with sessions.begin() as session:
        session.get(BillingOrder, UUID(order["id"])).status = "review"
        session.get(Subscription, accounts["alice"]["user_id"]).status = "review"
    assert not client.get("/v1/me/subscription", headers=headers).json()["checkout_available"]
    assert (
        client.post(
            "/v1/billing/checkouts",
            headers={**headers, "Idempotency-Key": str(uuid4())},
        ).status_code
        == 409
    )


@pytest.mark.parametrize("failure", ["provider_outage", "worker_crash"])
def test_refund_verification_survives_outage_or_worker_crash(
    client, accounts, billing, sessions, failure
):
    draft, order, _ = queued_order(client, accounts)
    transport, _, approved = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    with sessions.begin() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        row.verified_at = datetime.now(UTC) - timedelta(minutes=1)
    assert (
        client.post(
            "/v1/billing/webhooks/toss",
            json={
                "eventType": "PAYMENT_STATUS_CHANGED",
                "data": {"orderId": "mori-" + order["id"], "status": "CANCELED"},
            },
        ).status_code
        == 202
    )

    if failure == "provider_outage":
        asyncio.run(
            service.run_billing_once(
                sessions,
                billing,
                transport=httpx.MockTransport(lambda request: httpx.Response(503)),
            )
        )
        with sessions.begin() as session:
            row = session.get(BillingOrder, UUID(order["id"]))
            assert row.verify_requested
            assert row.available_at > datetime.now(UTC)
            row.available_at = datetime.now(UTC) - timedelta(seconds=1)
    else:
        claim = service.claim_order(sessions, billing, datetime.now(UTC))
        assert claim.verify_only
        assert service.claim_order(sessions, billing, datetime.now(UTC)) is None
        with sessions.begin() as session:
            row = session.get(BillingOrder, UUID(order["id"]))
            row.lease_until = datetime.now(UTC) - timedelta(seconds=1)

    calls = []

    def verified_refund(request):
        calls.append(request.method)
        return httpx.Response(200, json={**approved, "status": "CANCELED"})

    assert asyncio.run(
        service.run_billing_once(sessions, billing, transport=httpx.MockTransport(verified_refund))
    )
    assert calls == ["GET"]
    result = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert result["billing_status"] == "canceled"
    assert result["plan"] == "free"
    with sessions() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        assert row.status == "canceled"
        assert row.lease_token is None and row.lease_until is None
        assert not row.verify_requested


def test_refunded_subscription_cannot_resume_before_original_period_end(
    client, accounts, billing, sessions
):
    draft, order, _ = queued_order(client, accounts)
    transport, _, approved = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    with sessions.begin() as session:
        row = session.get(BillingOrder, UUID(order["id"]))
        row.verify_requested = True
        row.available_at = datetime.now(UTC) - timedelta(seconds=1)
    asyncio.run(
        service.run_billing_once(
            sessions,
            billing,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={**approved, "status": "CANCELED"})
            ),
        )
    )
    headers = accounts["alice"]["headers"]
    refunded = client.get("/v1/me/subscription", headers=headers).json()
    assert refunded["billing_status"] == "canceled"
    assert datetime.fromisoformat(refunded["current_period_end"]) > datetime.now(UTC)
    response = client.post(
        "/v1/billing/subscription/resume", headers=headers, json={"revision": refunded["revision"]}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SUBSCRIPTION_ENDED"
    assert client.get("/v1/me/subscription", headers=headers).json() == refunded


@pytest.mark.parametrize("admin_granted", [False, True])
def test_account_and_pro_guard_apply_paid_expiry_without_worker(
    client, accounts, billing, sessions, admin_granted
):
    from mori.membership.dependencies import CurrentProUser

    @client.app.get("/test/billing-pro-feature")
    def pro_feature(user: CurrentProUser):
        return {"user_id": str(user.id)}

    draft, order, _ = queued_order(client, accounts)
    transport, _, _ = provider(order, draft["customer_key"])
    asyncio.run(service.run_billing_once(sessions, billing, transport=transport))
    uid, headers = accounts["alice"]["user_id"], accounts["alice"]["headers"]
    with sessions.begin() as session:
        user = session.get(User, uid)
        if admin_granted:
            service.set_admin_access(session, user, True)
        session.get(Subscription, uid).current_period_end = datetime.now(UTC) - timedelta(seconds=1)
        assert user.tier == "pro"  # No worker has updated the persisted cache yet.

    expected = "pro" if admin_granted else "free"
    account = client.get("/v1/me", headers=headers).json()
    assert account["tier"] == expected
    assert client.get("/v1/me/subscription", headers=headers).json()["plan"] == expected
    assert client.get("/test/billing-pro-feature", headers=headers).status_code == (
        200 if admin_granted else 403
    )
    updated = client.patch(
        "/v1/me", headers=headers, json={"display_name": "Updated", "revision": account["revision"]}
    )
    assert updated.status_code == 200
    assert updated.json()["tier"] == expected


@pytest.mark.parametrize("customer_key", ["다른사용자", "customer-é"])
def test_non_ascii_customer_key_is_rejected_without_consuming_checkout(
    client, accounts, billing, sessions, monkeypatch, customer_key
):
    from mori.billing.models import Checkout

    async def unexpected_provider_request(*args, **kwargs):
        pytest.fail("Invalid checkout completion must not call Toss")

    monkeypatch.setattr(service.TossClient, "request", unexpected_provider_request)
    draft = checkout(client, accounts)
    user_id = accounts["alice"]["user_id"]
    with sessions() as session:
        sub = session.get(Subscription, user_id)
        before = (sub.status, sub.revision, sub.cancel_at_period_end, sub.amount)
    path = f"/v1/billing/checkouts/{draft['id']}/complete"
    response = client.post(
        path,
        headers=accounts["alice"]["headers"],
        json={"customer_key": customer_key, "auth_key": "private-one-time-auth-key"},
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "CHECKOUT_CUSTOMER_MISMATCH"
    with sessions() as session:
        assert session.get(Checkout, UUID(draft["id"])).order_id is None
        assert session.scalar(select(func.count()).select_from(BillingOrder)) == 0
        sub = session.get(Subscription, user_id)
        assert (sub.status, sub.revision, sub.cancel_at_period_end, sub.amount) == before
        assert session.get(User, user_id).tier == "free"
    response = client.post(
        path,
        headers=accounts["alice"]["headers"],
        json={"customer_key": draft["customer_key"], "auth_key": "private-one-time-auth-key"},
    )
    assert response.status_code == 202, response.text
