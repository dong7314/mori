import base64
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from test_chat import agent as agent
from test_chat import conversation, events, send

from mori.notifications.models import PushSubscription, ReminderDelivery
from mori.notifications.schemas import SubscriptionWrite
from mori.notifications.service import (
    _claim_one,
    _send_claim,
    deliver_due,
    enqueue_due,
    send_webpush,
    validate_allowed_hosts,
    validate_push_configuration,
)


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def configuration():
    private = ec.generate_private_key(ec.SECP256R1())
    return SimpleNamespace(
        push_enabled=True,
        vapid_public_key=b64(
            private.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        ),
        vapid_private_key=SecretStr(b64(private.private_numbers().private_value.to_bytes(32))),
        vapid_subject="mailto:notifications@mori.test",
        push_allowed_hosts=[
            "fcm.googleapis.com",
            "updates.push.services.mozilla.com",
            "web.push.apple.com",
        ],
        push_timeout_seconds=10,
        push_max_attempts=3,
        push_lease_seconds=60,
    )


@pytest.fixture
def push_settings(client):
    settings = client.app.state.settings
    for name, value in vars(configuration()).items():
        setattr(settings, name, value)
    return settings


def subscription_payload(settings, endpoint=None):
    return {
        "endpoint": endpoint or "https://fcm.googleapis.com/fcm/send/" + uuid4().hex,
        "keys": {"p256dh": settings.vapid_public_key, "auth": b64(b"a" * 16)},
        "device_name": "내 휴대폰",
    }


def subscribe(client, accounts, settings, *, who="alice", endpoint=None):
    payload = subscription_payload(settings, endpoint)
    response = client.post(
        "/v1/notifications/subscriptions", json=payload, headers=accounts[who]["headers"]
    )
    assert response.status_code == 201, response.text
    return response.json(), payload


def reminder(client, accounts, *, minutes=5, who="alice"):
    target = datetime.now(UTC) + timedelta(minutes=minutes)
    response = client.post(
        "/v1/reminders",
        json={"title": "물 한 잔", "target_at": target.isoformat()},
        headers={**accounts[who]["headers"], "Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json(), target + timedelta(seconds=1)


def accepted(**_kwargs):
    return SimpleNamespace(status_code=201)


class ProviderFailure(Exception):
    def __init__(self, status=None):
        super().__init__("Do not persist provider body, endpoint or secret")
        self.response = SimpleNamespace(status_code=status)


def deliveries(client, accounts, reminder_id):
    response = client.get(
        f"/v1/reminders/{reminder_id}/deliveries", headers=accounts["alice"]["headers"]
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_push_disabled_is_explicit_and_does_not_enqueue(client, accounts, sessions):
    settings = client.app.state.settings
    config = client.get("/v1/notifications/push-config")
    assert config.status_code == 200
    assert config.json() == {
        "enabled": False,
        "public_key": None,
        "delivery_semantics": "provider_accepted",
    }
    response = client.post(
        "/v1/notifications/subscriptions",
        json=subscription_payload(configuration()),
        headers=accounts["alice"]["headers"],
    )
    assert response.status_code == 503
    assert not deliver_due(sessions, settings, sender=accepted)["enabled"]


def test_subscription_registration_is_owned_idempotent_and_revocable(
    client, accounts, push_settings
):
    headers = accounts["alice"]["headers"]
    row, payload = subscribe(client, accounts, push_settings)
    public = client.get("/v1/notifications/push-config").json()
    assert public["enabled"] and public["public_key"] == push_settings.vapid_public_key
    assert push_settings.vapid_private_key.get_secret_value() not in json.dumps(public)
    repeated = client.post("/v1/notifications/subscriptions", json=payload, headers=headers).json()
    assert repeated["id"] == row["id"]
    assert "keys" not in repeated and "endpoint" not in repeated
    assert client.post("/v1/notifications/subscriptions", json=payload).status_code == 401
    assert (
        client.post(
            "/v1/notifications/subscriptions", json=payload, headers=accounts["bob"]["headers"]
        ).status_code
        == 409
    )
    assert (
        client.get("/v1/notifications/subscriptions", headers=accounts["bob"]["headers"]).json()
        == []
    )
    url = "/v1/notifications/subscriptions/" + row["id"]
    assert client.delete(url, headers=accounts["bob"]["headers"]).status_code == 404
    assert not client.delete(url, headers=headers).json()["active"]
    restored = client.post("/v1/notifications/subscriptions", json=payload, headers=headers).json()
    assert restored["id"] == row["id"] and restored["active"]


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/push/token",
        "https://localhost/push/token",
        "https://127.0.0.1/push/token",
        "https://[::1]/push/token",
        "https://fcm.googleapis.com.evil.test/push/token",
        "https://fcm.googleapis.com@evil.test/push/token",
        "https://fcm.googleapis.com:8443/push/token",
        "https://fcm.googleapis.com/push/token#fragment",
        "https://fcm.googleapis.com\\@evil.test/push/token",
    ],
)
def test_subscription_rejects_untrusted_endpoints(client, accounts, push_settings, endpoint):
    response = client.post(
        "/v1/notifications/subscriptions",
        json=subscription_payload(push_settings, endpoint),
        headers=accounts["alice"]["headers"],
    )
    assert response.status_code == 422


def test_push_keys_configuration_and_allowlist_are_validated():
    settings = configuration()
    assert validate_push_configuration(settings)
    settings.vapid_public_key = configuration().vapid_public_key
    with pytest.raises(ValueError, match="do not match"):
        validate_push_configuration(settings)
    for host in ("*.googleapis.com", "127.0.0.1", "localhost", "push.local", "example.test:443"):
        with pytest.raises(ValueError):
            validate_allowed_hosts([host])
    payload = subscription_payload(configuration())
    for keys in (
        {"p256dh": "not-a-point", "auth": payload["keys"]["auth"]},
        {"p256dh": payload["keys"]["p256dh"], "auth": b64(b"short")},
    ):
        with pytest.raises(ValidationError):
            SubscriptionWrite.model_validate({**payload, "keys": keys})


def test_actual_webpush_encrypts_and_disables_redirects(monkeypatch):
    settings = configuration()
    payload = subscription_payload(settings)
    seen = []

    def request(http, method, url, **options):
        seen.append((http, method, url, options))
        response = requests.Response()
        response.status_code = 201
        response._content = b""
        return response

    monkeypatch.setattr(requests.Session, "request", request)
    response = send_webpush(
        subscription_info={"endpoint": payload["endpoint"], "keys": payload["keys"]},
        data='{"title":"private reminder"}',
        vapid_private_key=settings.vapid_private_key.get_secret_value(),
        vapid_claims={"sub": settings.vapid_subject},
        timeout=10,
        ttl=300,
    )
    assert response.status_code == 201 and len(seen) == 1
    http, method, endpoint, options = seen[0]
    assert method.lower() == "post" and endpoint == payload["endpoint"]
    assert options["allow_redirects"] is False and not http.trust_env
    assert options["timeout"] == 10
    assert options["headers"]["content-encoding"] == "aes128gcm"
    assert b"private reminder" not in options["data"]
    assert options["headers"]["authorization"].startswith("vapid ")


def test_due_reminder_is_delivered_once_per_device_and_exposes_status(
    client, accounts, sessions, push_settings
):
    subscribe(client, accounts, push_settings)
    subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)
    calls = []

    def sender(**kwargs):
        calls.append(kwargs)
        return accepted()

    first = deliver_due(sessions, push_settings, now=due, sender=sender)
    assert first["queued"] == first["sent"] == 2
    second = deliver_due(sessions, push_settings, now=due, sender=sender)
    assert second["queued"] == second["processed"] == 0 and len(calls) == 2
    payloads = [json.loads(call["data"]) for call in calls]
    assert payloads[0]["tag"] == payloads[1]["tag"]
    assert payloads[0]["delivery_id"] != payloads[1]["delivery_id"]
    assert all(payload["reminder_id"] == row["id"] for payload in payloads)
    statuses = deliveries(client, accounts, row["id"])
    assert len(statuses) == 2 and all(item["status"] == "sent" for item in statuses)
    assert all(item["attempts"] == 1 and item["provider_status"] == 201 for item in statuses)
    assert all("endpoint" not in item and "lease_token" not in item for item in statuses)
    assert client.get(f"/v1/reminders/{row['id']}/deliveries").status_code == 401
    assert (
        client.get(
            f"/v1/reminders/{row['id']}/deliveries", headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )


def test_provider_failures_have_bounded_backoff_and_stable_dedup_tag(
    client, accounts, sessions, push_settings
):
    subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)
    calls = []

    def sender(**kwargs):
        calls.append(json.loads(kwargs["data"]))
        raise ProviderFailure(503)

    assert deliver_due(sessions, push_settings, now=due, sender=sender)["retry"] == 1
    assert (
        deliver_due(sessions, push_settings, now=due + timedelta(seconds=29), sender=sender)[
            "processed"
        ]
        == 0
    )
    assert (
        deliver_due(sessions, push_settings, now=due + timedelta(seconds=30), sender=sender)[
            "retry"
        ]
        == 1
    )
    assert (
        deliver_due(sessions, push_settings, now=due + timedelta(seconds=90), sender=sender)[
            "failed"
        ]
        == 1
    )
    assert (
        deliver_due(sessions, push_settings, now=due + timedelta(hours=1), sender=sender)[
            "processed"
        ]
        == 0
    )
    assert len(calls) == 3 and len({call["tag"] for call in calls}) == 1
    stored = deliveries(client, accounts, row["id"])[0]
    assert stored["status"] == "failed" and stored["attempts"] == 3
    assert stored["last_error_code"] == "ATTEMPTS_EXHAUSTED"


@pytest.mark.parametrize("status", [404, 410])
def test_expired_provider_subscription_is_deactivated(
    client, accounts, sessions, push_settings, status
):
    sub, _ = subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)

    def sender(**_kwargs):
        raise ProviderFailure(status)

    assert deliver_due(sessions, push_settings, now=due, sender=sender)["failed"] == 1
    with sessions() as session:
        assert not session.get(PushSubscription, UUID(sub["id"])).active
    assert deliveries(client, accounts, row["id"])[0]["last_error_code"] == "SUBSCRIPTION_GONE"
    _, later = reminder(client, accounts, minutes=10)
    assert deliver_due(sessions, push_settings, now=later, sender=sender)["queued"] == 0


@pytest.mark.parametrize("change", ["cancel", "delete", "target", "unsubscribe"])
def test_pending_deliveries_recheck_domain_state_before_dispatch(
    client, accounts, sessions, push_settings, change
):
    sub, _ = subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)
    assert enqueue_due(sessions, due) == 1
    headers = accounts["alice"]["headers"]
    url = "/v1/reminders/" + row["id"]
    if change == "cancel":
        assert (
            client.post(url + "/cancel", json={"revision": 1}, headers=headers).status_code == 200
        )
    elif change == "delete":
        assert client.delete(url, params={"revision": 1}, headers=headers).status_code == 200
    elif change == "target":
        assert (
            client.put(
                url,
                json={
                    "revision": 1,
                    "title": row["title"],
                    "target_at": (due + timedelta(hours=1)).isoformat(),
                },
                headers=headers,
            ).status_code
            == 200
        )
    else:
        assert (
            client.delete(
                "/v1/notifications/subscriptions/" + sub["id"], headers=headers
            ).status_code
            == 200
        )
    summary = deliver_due(
        sessions, push_settings, now=due, sender=lambda **_: pytest.fail("sent stale reminder")
    )
    assert summary["skipped"] == 1
    with sessions() as session:
        saved = session.scalar(select(ReminderDelivery))
        assert saved.status == "skipped"
        assert (
            saved.last_error_code
            == {
                "cancel": "REMINDER_CANCELLED",
                "delete": "REMINDER_DELETED",
                "target": "TARGET_CHANGED",
                "unsubscribe": "SUBSCRIPTION_INACTIVE",
            }[change]
        )


def test_expired_lease_is_reclaimed_and_old_owner_cannot_send(
    client, accounts, sessions, push_settings
):
    subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)
    enqueue_due(sessions, due)
    old_claim = _claim_one(sessions, push_settings, due)
    assert old_claim is not None
    assert deliver_due(sessions, push_settings, now=due, sender=accepted)["processed"] == 0
    later = due + timedelta(seconds=push_settings.push_lease_seconds + 1)
    assert deliver_due(sessions, push_settings, now=later, sender=accepted)["sent"] == 1
    assert (
        _send_claim(
            sessions, push_settings, old_claim, later, lambda **_: pytest.fail("stale lease sent")
        )
        == "skipped"
    )
    assert deliveries(client, accounts, row["id"])[0]["attempts"] == 2


def test_workers_racing_for_same_due_target_send_once(client, accounts, sessions, push_settings):
    subscribe(client, accounts, push_settings)
    _, due = reminder(client, accounts)
    calls = []

    def sender(**kwargs):
        calls.append(kwargs)
        return accepted()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda _: deliver_due(sessions, push_settings, now=due, sender=sender), range(2)
            )
        )
    assert sum(result["sent"] for result in results) == 1 and len(calls) == 1


def test_expired_claim_cannot_send_until_reclaimed(client, accounts, sessions, push_settings):
    subscribe(client, accounts, push_settings)
    _, due = reminder(client, accounts)
    enqueue_due(sessions, due)
    claim = _claim_one(sessions, push_settings, due)
    assert claim is not None
    expired = due + timedelta(seconds=push_settings.push_lease_seconds)
    assert (
        _send_claim(
            sessions, push_settings, claim, expired, lambda **_: pytest.fail("expired lease sent")
        )
        == "skipped"
    )
    assert deliver_due(sessions, push_settings, now=expired, sender=accepted)["sent"] == 1


def test_reactivated_subscription_does_not_receive_pre_activation_queue(
    client, accounts, sessions, push_settings
):
    sub, _ = subscribe(client, accounts, push_settings)
    row, due = reminder(client, accounts)
    enqueue_due(sessions, due)
    # Simulate unsubscribing and subscribing again after this target had elapsed.
    with sessions.begin() as session:
        subscription = session.get(PushSubscription, UUID(sub["id"]))
        subscription.activated_at = due + timedelta(seconds=1)
    summary = deliver_due(
        sessions,
        push_settings,
        now=due + timedelta(seconds=2),
        sender=lambda **_: pytest.fail("pre-activation reminder sent"),
    )
    assert summary["skipped"] == 1
    assert deliveries(client, accounts, row["id"])[0]["last_error_code"] == (
        "SUBSCRIPTION_REACTIVATED"
    )


def test_reminder_reads_report_current_push_readiness_across_mutations(
    client, accounts, push_settings
):
    headers = accounts["alice"]["headers"]
    key = str(uuid4())
    payload = {
        "title": "연결 확인",
        "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }
    create_headers = {**headers, "Idempotency-Key": key}
    created = client.post("/v1/reminders", json=payload, headers=create_headers).json()
    url = "/v1/reminders/" + created["id"]
    assert created["delivery_status"] == "no_subscription"
    assert created["deliveries_url"] == url + "/deliveries"
    assert client.get(url, headers=headers).json()["delivery_status"] == "no_subscription"
    assert client.get("/v1/reminders", headers=headers).json()[0]["delivery_status"] == (
        "no_subscription"
    )
    sub, _ = subscribe(client, accounts, push_settings)
    # Readiness is current request context, even when the creation receipt is replayed.
    replayed = client.post("/v1/reminders", json=payload, headers=create_headers).json()
    assert replayed["id"] == created["id"] and replayed["delivery_status"] == "ready"
    assert client.get(url, headers=headers).json()["delivery_status"] == "ready"
    assert client.get("/v1/reminders", headers=headers).json()[0]["delivery_status"] == "ready"
    assert client.get(replayed["deliveries_url"], headers=headers).json() == []

    updated = client.put(url, json={**payload, "revision": 1}, headers=headers).json()
    assert updated["delivery_status"] == "ready"
    cancelled = client.post(url + "/cancel", json={"revision": 2}, headers=headers).json()
    assert cancelled["delivery_status"] == "ready" and cancelled["cancelled"]
    resumed = client.post(
        url + "/resume", json={"revision": 3, "target_at": payload["target_at"]}, headers=headers
    ).json()
    assert resumed["delivery_status"] == "ready" and not resumed["cancelled"]
    extended = client.post(url + "/extend", json={"revision": 4}, headers=headers).json()
    assert extended["delivery_status"] == "ready"
    deleted = client.delete(url, params={"revision": 5}, headers=headers).json()
    assert deleted["delivery_status"] == "ready"
    restored = client.post(url + "/restore", json={"revision": 6}, headers=headers).json()
    assert restored["delivery_status"] == "ready"

    other, _ = reminder(client, accounts, who="bob")
    assert other["delivery_status"] == "no_subscription"
    client.delete("/v1/notifications/subscriptions/" + sub["id"], headers=headers)
    assert client.get(url, headers=headers).json()["delivery_status"] == "no_subscription"
    push_settings.push_enabled = False
    assert client.get(url, headers=headers).json()["delivery_status"] == "not_configured"


def test_chat_reminder_snapshot_defers_push_readiness_to_http_lookup(
    client, accounts, agent, push_settings
):
    subscribe(client, accounts, push_settings)
    agent.decision = {
        "action": "reminder_save",
        "reminder": {
            "title": "음성으로 부탁한 알림",
            "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        },
    }
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.completed"
    result = next(item["result"] for item in observed if item["type"] == "action.completed")
    assert result["delivery_status"] == "unknown"
    assert result["deliveries_url"] == f"/v1/reminders/{result['id']}/deliveries"
    latest = client.get(
        f"/v1/reminders/{result['id']}", headers=accounts["alice"]["headers"]
    ).json()
    assert latest["delivery_status"] == "ready"
