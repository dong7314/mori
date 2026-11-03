from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from mori.billing import service
from mori.billing.models import BillingOrder, Subscription


@pytest.fixture
def enabled_billing(client):
    settings = client.app.state.settings
    settings.billing_enabled = True
    settings.billing_encryption_key = SecretStr(Fernet.generate_key().decode())
    settings.billing_pro_amount = 12000
    settings.billing_toss_client_key = "test_ck_public"
    settings.billing_success_url = "https://app.test/success"
    settings.billing_fail_url = "https://app.test/fail"
    return settings


def queue_checkout(client, accounts):
    headers = accounts["alice"]["headers"]
    response = client.post(
        "/v1/billing/checkouts", headers={**headers, "Idempotency-Key": str(uuid4())}
    )
    assert response.status_code == 201, response.text
    draft = response.json()
    response = client.post(
        f"/v1/billing/checkouts/{draft['id']}/complete",
        headers=headers,
        json={"customer_key": draft["customer_key"], "auth_key": "auth"},
    )
    assert response.status_code == 202, response.text
    return response.json()


def payment(claim, *, approved=None, status="DONE"):
    return {
        "orderId": f"mori-{claim.id}",
        "paymentKey": f"payment-{claim.id}",
        "type": "BILLING",
        "currency": "KRW",
        "totalAmount": 12000,
        "status": status,
        "approvedAt": (approved or datetime.now(UTC)).isoformat(),
    }


def claim_verification(sessions, settings, order_id):
    with sessions.begin() as session:
        session.get(BillingOrder, order_id).verified_at = datetime.now(UTC) - timedelta(minutes=1)
    with sessions() as session:
        service.request_verification(session, f"mori-{order_id}")
    claim = service.claim_order(sessions, settings, datetime.now(UTC))
    assert claim.id == order_id and claim.verify_only
    return claim


@pytest.mark.parametrize("order_status", ["processing", "review"])
def test_first_confirmed_refund_finishes_unconfirmed_subscription(
    client, accounts, sessions, enabled_billing, order_status
):
    order = queue_checkout(client, accounts)
    if order_status == "review":
        with sessions.begin() as session:
            row = session.get(BillingOrder, UUID(order["id"]))
            row.status, row.verify_requested = "review", True
            session.get(Subscription, row.user_id).status = "review"
    claim = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    # Approval can be lost before the merchant refunds the charge. The first
    # successful lookup then already reports the authoritative cancellation.
    assert service.complete_order(sessions, claim, payment(claim, status="CANCELED"))
    with sessions() as session:
        assert session.get(BillingOrder, claim.id).status == "canceled"
        sub = session.get(Subscription, claim.user_id)
        assert sub.status == "canceled" and sub.cancel_at_period_end
    current = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert current["billing_status"] == "canceled" and current["plan"] == "free"
    assert current["checkout_available"]


def test_first_confirmed_renewal_refund_finishes_past_due_subscription(
    client, accounts, sessions, enabled_billing
):
    queue_checkout(client, accounts)
    original = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    assert service.complete_order(
        sessions,
        original,
        payment(original, approved=datetime.now(UTC) - timedelta(days=40)),
    )
    service.enqueue_renewals(sessions, datetime.now(UTC))
    renewal = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    assert renewal.id != original.id
    assert service.complete_order(sessions, renewal, payment(renewal, status="CANCELED"))
    with sessions() as session:
        assert session.get(Subscription, original.user_id).status == "canceled"


def test_older_paid_refund_preserves_replacement_order_and_its_auto_renewal(
    client, accounts, sessions, enabled_billing
):
    queue_checkout(client, accounts)
    original = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    paid = payment(original, approved=datetime.now(UTC) - timedelta(days=40))
    assert service.complete_order(sessions, original, paid)
    replacement = queue_checkout(client, accounts)
    with sessions() as session:
        sub = session.get(Subscription, original.user_id)
        revision = sub.revision
        assert sub.status == "pending" and not sub.cancel_at_period_end
    verification = claim_verification(sessions, enabled_billing, original.id)
    assert service.complete_order(sessions, verification, {**paid, "status": "CANCELED"})
    with sessions() as session:
        sub = session.get(Subscription, original.user_id)
        assert sub.status == "pending" and not sub.cancel_at_period_end
        assert sub.revision == revision
        assert session.get(BillingOrder, UUID(replacement["id"])).status == "pending"
    latest = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    assert latest.id == UUID(replacement["id"])
    assert service.complete_order(sessions, latest, payment(latest))
    current = client.get("/v1/me/subscription", headers=accounts["alice"]["headers"]).json()
    assert current["plan"] == "pro" and current["billing_status"] == "active"
    assert not current["cancel_at_period_end"]


@pytest.mark.parametrize("old_status", ["canceled", "failed"])
def test_terminal_order_refund_cannot_finish_new_pending_checkout(
    client, accounts, sessions, enabled_billing, old_status
):
    queue_checkout(client, accounts)
    original = service.claim_order(sessions, enabled_billing, datetime.now(UTC))
    canceled = payment(original, status="CANCELED")
    if old_status == "failed":
        service.fail_order(sessions, original, "BILLING_PROVIDER_REJECTED")
    else:
        assert service.complete_order(sessions, original, canceled)
    replacement = queue_checkout(client, accounts)
    with sessions() as session:
        revision = session.get(Subscription, original.user_id).revision
    verification = claim_verification(sessions, enabled_billing, original.id)
    assert service.complete_order(sessions, verification, canceled)
    with sessions() as session:
        sub = session.get(Subscription, original.user_id)
        assert sub.status == "pending" and not sub.cancel_at_period_end
        assert sub.revision == revision
        assert session.get(BillingOrder, UUID(replacement["id"])).status == "pending"
