import asyncio
import base64
import copy
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from mori.auth.models import User
from mori.errors import ApiError
from mori.runtimes.kubernetes import Kubernetes, labels
from mori.runtimes.models import RuntimeBinding
from mori.runtimes.service import (
    claim_due,
    decrypt_key,
    finish_claim,
    process_once,
    reconcile,
    resolve_binding,
    sync_entitlements,
)
from mori.runtimes.settings import RuntimeSettings

NOW = datetime(2026, 11, 2, 0, 0, tzinfo=UTC)


@pytest.fixture
def runtime_settings(settings):
    values = RuntimeSettings().model_dump()
    values.update(
        runtime_provisioning_enabled=True,
        runtime_image="harbor.example/mori/hermes@sha256:" + "a" * 64,
        runtime_master_key=Fernet.generate_key().decode(),
        runtime_llm_url="http://llm.internal:8080/v1",
        runtime_llm_model="qwen-test",
    )
    validated = RuntimeSettings(**values)
    return settings.model_copy(update={**validated.model_dump(), "chat_enabled": True})


class Cluster:
    """API-shaped cluster double: identity, Ready generation, deletion and failures."""

    def __init__(self):
        self.objects = {}
        self.calls = []
        self.pods = []
        self.ready = True
        self.fail = False
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request):
        assert request.headers["authorization"] == "Bearer test-token"
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        if self.fail:
            return httpx.Response(503, json={"message": "secret-provider-raw-error"})
        if path.endswith("/pods"):
            assert "mori.app/runtime-id=" in request.url.params["labelSelector"]
            return httpx.Response(200, json={"items": self.pods})
        if method == "GET":
            return (
                httpx.Response(200, json=self.objects[path])
                if path in self.objects
                else httpx.Response(404, json={})
            )
        if method == "POST":
            body = json.loads(request.content)
            key = path + "/" + body["metadata"]["name"]
            if key in self.objects:
                return httpx.Response(409, json={})
            body["metadata"].update(uid=str(uuid4()), generation=1)
            if body["kind"] == "Service":
                meta = body["metadata"]
                body["status"] = {
                    "conditions": [
                        {"type": "Ready", "status": "True" if self.ready else "Unknown"}
                    ],
                    "observedGeneration": 1,
                    "url": f"http://{meta['name']}.{meta['namespace']}.svc.cluster.local",
                }
            self.objects[key] = copy.deepcopy(body)
            return httpx.Response(201, json=body)
        if method == "DELETE":
            options = json.loads(request.content)
            assert options["propagationPolicy"] == "Foreground"
            assert options["preconditions"]["uid"] == self.objects[path]["metadata"]["uid"]
            del self.objects[path]
            return httpx.Response(200, json={"kind": "Status"})
        raise AssertionError((method, path))


def tier(sessions, uid, value):
    with sessions.begin() as session:
        session.get(User, uid).tier = value


def step(sessions, settings, cluster, seconds=0):
    return asyncio.run(
        process_once(
            sessions, settings, transport=cluster.transport, now=NOW + timedelta(seconds=seconds)
        )
    )


def test_approval_creates_isolated_ready_runtime_and_redacts_credentials(
    runtime_settings, sessions, accounts
):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    assert step(sessions, runtime_settings, cluster)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.status == "ready"
        runtime = resolve_binding(session, runtime_settings, uid, "pro")
        assert runtime.url == f"http://hermes-{uid.hex}.mori-agents.svc.cluster.local"
        assert row.encrypted_api_key != runtime.key.get_secret_value()
        secret = next(v for v in cluster.objects.values() if v["kind"] == "Secret")
        assert (
            base64.b64decode(secret["data"]["API_SERVER_KEY"]).decode()
            == runtime.key.get_secret_value()
        )
        service = next(v for v in cluster.objects.values() if v["kind"] == "Service")
        pod = service["spec"]["template"]["spec"]
        assert pod["automountServiceAccountToken"] is False
        assert pod["containerConcurrency"] == 1
        assert (
            service["spec"]["template"]["metadata"]["annotations"][
                "autoscaling.knative.dev/min-scale"
            ]
            == "0"
        )
        assert service["metadata"]["labels"]["networking.knative.dev/visibility"] == "cluster-local"
    created = len([method for method, _ in cluster.calls if method == "POST"])
    assert created == 4
    assert step(sessions, runtime_settings, cluster, 11)
    assert len([m for m, _ in cluster.calls if m == "POST"]) == created


def test_two_pro_users_get_distinct_home_and_keys(runtime_settings, sessions, accounts):
    for account in accounts.values():
        tier(sessions, account["user_id"], "pro")
    cluster = Cluster()
    assert step(sessions, runtime_settings, cluster)
    assert step(sessions, runtime_settings, cluster)
    keys, homes = set(), set()
    for resource in cluster.objects.values():
        if resource["kind"] == "Secret":
            keys.add(resource["data"]["API_SERVER_KEY"])
        if resource["kind"] == "PersistentVolumeClaim":
            homes.add(resource["metadata"]["name"])
    assert len(keys) == len(homes) == 2
    with sessions() as session:
        alice = resolve_binding(session, runtime_settings, accounts["alice"]["user_id"], "pro")
        bob = resolve_binding(session, runtime_settings, accounts["bob"]["user_id"], "pro")
        assert alice.url != bob.url and alice.key != bob.key


def test_revoke_denies_immediately_drains_service_retains_home_and_rotates_key_on_regrant(
    runtime_settings, sessions, accounts
):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    with sessions() as session:
        old = resolve_binding(session, runtime_settings, uid, "pro").key.get_secret_value()
    home = next(
        copy.deepcopy(v) for v in cluster.objects.values() if v["kind"] == "PersistentVolumeClaim"
    )
    tier(sessions, uid, "free")
    with sessions() as session:
        with pytest.raises(ApiError, match="PRO_REQUIRED"):
            resolve_binding(session, runtime_settings, uid, "pro")
    assert step(sessions, runtime_settings, cluster, 1)
    assert list(cluster.objects.values()) == [home]
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.status == "suspended" and row.encrypted_api_key is None and row.base_url is None
    tier(sessions, uid, "pro")
    step(sessions, runtime_settings, cluster, 2)
    with sessions() as session:
        assert resolve_binding(session, runtime_settings, uid, "pro").key.get_secret_value() != old
    assert next(v for v in cluster.objects.values() if v["kind"] == "PersistentVolumeClaim") == home


def test_foreign_resource_never_adopted_or_deleted(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    path = f"/api/v1/namespaces/mori-agents/persistentvolumeclaims/hermes-{uid.hex}"
    foreign = {
        "kind": "PersistentVolumeClaim",
        "metadata": {"labels": {"mori.app/user-id": "other"}},
    }
    cluster.objects[path] = foreign
    step(sessions, runtime_settings, cluster)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.status == "retry" and row.error_code == "RUNTIME_RESOURCE_CONFLICT"
    assert cluster.objects == {path: foreign}
    assert not any(method in {"POST", "DELETE"} for method, _ in cluster.calls)


def test_readiness_needs_observed_generation_and_internal_route(
    runtime_settings, sessions, accounts
):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    cluster.ready = False
    step(sessions, runtime_settings, cluster)
    with sessions() as session:
        with pytest.raises(ApiError, match="RUNTIME_NOT_READY"):
            resolve_binding(session, runtime_settings, uid, "pro")
    service = next(v for v in cluster.objects.values() if v["kind"] == "Service")
    service["status"]["conditions"][0]["status"] = "True"
    service["status"]["observedGeneration"] = 0
    step(sessions, runtime_settings, cluster, 11)
    with sessions() as session:
        assert session.get(RuntimeBinding, uid).status == "provisioning"
    service["status"]["observedGeneration"] = 1
    service["status"]["url"] = "https://other.example/"
    step(sessions, runtime_settings, cluster, 22)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert (
            row.status == "retry"
            and row.error_code == "RUNTIME_ROUTE_INVALID"
            and row.base_url is None
        )


def test_retry_backoff_and_sanitized_errors(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    cluster.fail = True
    step(sessions, runtime_settings, cluster)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.error_code == "RUNTIME_CLUSTER_UNAVAILABLE"
        assert row.next_check_at == NOW + timedelta(seconds=20)
    assert not step(sessions, runtime_settings, cluster, 1)
    cluster.fail = False
    step(sessions, runtime_settings, cluster, 21)
    with sessions() as session:
        assert session.get(RuntimeBinding, uid).status == "ready"


def test_old_lease_cannot_publish_ready_after_revoke(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    sync_entitlements(sessions, runtime_settings, NOW)
    claim = claim_due(sessions, runtime_settings, NOW)
    assert claim_due(sessions, runtime_settings, NOW) is None
    tier(sessions, uid, "free")
    sync_entitlements(sessions, runtime_settings, NOW + timedelta(seconds=1))
    assert not finish_claim(
        sessions,
        runtime_settings,
        claim,
        ("ready", "http://unsafe", None),
        NOW + timedelta(seconds=2),
    )
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.desired == "suspended" and row.base_url is None and row.encrypted_api_key is None
    # Cleanup must not race the still-running request belonging to the old lease.
    assert claim_due(sessions, runtime_settings, NOW + timedelta(seconds=2)) is None


def test_suspended_runtime_periodically_removes_late_cluster_creations(
    runtime_settings, sessions, accounts
):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    previous = copy.deepcopy(cluster.objects)
    tier(sessions, uid, "free")
    step(sessions, runtime_settings, cluster, 1)
    assert all(resource["kind"] == "PersistentVolumeClaim" for resource in cluster.objects.values())
    # A remote Kubernetes POST can complete after its client timed out and cleanup finished.
    cluster.objects.update(previous)
    assert not step(sessions, runtime_settings, cluster, 2)
    assert step(sessions, runtime_settings, cluster, 301)
    assert all(resource["kind"] == "PersistentVolumeClaim" for resource in cluster.objects.values())
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.status == "suspended" and row.encrypted_api_key is None


def test_regrant_does_not_steal_running_suspension_audit(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    tier(sessions, uid, "free")
    step(sessions, runtime_settings, cluster, 1)
    audit = claim_due(sessions, runtime_settings, NOW + timedelta(seconds=301))
    assert audit.desired == "suspended"
    tier(sessions, uid, "pro")
    sync_entitlements(sessions, runtime_settings, NOW + timedelta(seconds=302))
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.desired == "suspended" and row.lease_token == audit.token
    assert finish_claim(
        sessions,
        runtime_settings,
        audit,
        ("suspended", None, None),
        NOW + timedelta(seconds=303),
    )
    step(sessions, runtime_settings, cluster, 304)
    with sessions() as session:
        assert session.get(RuntimeBinding, uid).status == "ready"


@pytest.mark.parametrize("chat_enabled", [False, True])
def test_public_status_matches_shared_routing_for_pro_without_provisioning(
    settings, sessions, accounts, chat_enabled
):
    from mori.chat.runtime import resolve_runtime, runtime_headers
    from mori.runtimes.router import public_status

    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    settings = settings.model_copy(
        update={
            "chat_enabled": chat_enabled,
            "shared_hermes_enabled": True,
            "shared_hermes_base_url": "http://shared.test",
            "shared_hermes_api_key": SecretStr("shared-key"),
        }
    )
    with sessions() as session:
        user = session.get(User, uid)
        status = public_status(user, None, settings)
        assert status.source == "shared_isolated" and status.status == "configured"
        assert status.access_allowed is chat_enabled
        if chat_enabled:
            runtime = resolve_runtime(settings, uid, "pro", session=session)
            assert runtime_headers(runtime)["X-Mori-User-ID"] == str(uid)
        else:
            with pytest.raises(ApiError, match="CHAT_DISABLED"):
                resolve_runtime(settings, uid, "pro", session=session)


def test_ready_managed_runtime_does_not_advertise_chat_when_disabled(
    runtime_settings, sessions, accounts
):
    from mori.runtimes.router import public_status

    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    step(sessions, runtime_settings, Cluster())
    runtime_settings.chat_enabled = False
    with sessions() as session:
        status = public_status(
            session.get(User, uid), session.get(RuntimeBinding, uid), runtime_settings
        )
        assert status.status == "ready" and not status.access_allowed


@pytest.mark.parametrize("plan", ["free", "pro"])
def test_operator_test_runtime_status_matches_legacy_owner_routing(settings, accounts, plan):
    from mori.chat.runtime import resolve_runtime
    from mori.runtimes.router import public_status

    uid = accounts["alice"]["user_id"]
    user = User(id=uid, tier=plan)
    settings = settings.model_copy(
        update={
            "chat_enabled": True,
            "hermes_test_user_id": uid,
            "hermes_base_url": "http://operator.test",
            "hermes_api_key": SecretStr("operator-key"),
        }
    )
    status = public_status(user, None, settings)
    assert status.source == "operator_assigned" and status.access_allowed
    assert resolve_runtime(settings, uid, plan).url == "http://operator.test"


def test_free_pro_free_routes_only_to_current_entitled_environment(
    runtime_settings, sessions, accounts
):
    from mori.billing.service import set_admin_access
    from mori.chat.runtime import resolve_runtime, runtime_headers

    uid = accounts["alice"]["user_id"]
    runtime_settings.shared_hermes_enabled = True
    runtime_settings.shared_hermes_base_url = "http://shared.test"
    runtime_settings.shared_hermes_api_key = SecretStr("shared-key")
    with sessions.begin() as session:
        free = resolve_runtime(runtime_settings, uid, "free", session=session)
        assert runtime_headers(free)["X-Mori-User-ID"] == str(uid)
        set_admin_access(session, session.get(User, uid), True)
    with sessions() as session:
        with pytest.raises(ApiError, match="RUNTIME_NOT_READY"):
            resolve_runtime(runtime_settings, uid, "pro", session=session)
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    with sessions.begin() as session:
        pro = resolve_runtime(runtime_settings, uid, "pro", session=session)
        assert pro.url != free.url and pro.key != free.key
        assert "X-Mori-User-ID" not in runtime_headers(pro)
        set_admin_access(session, session.get(User, uid), False)
    # Route back to the user's shared profile immediately, even before PVC cleanup.
    with sessions() as session:
        downgraded = resolve_runtime(runtime_settings, uid, "pro", session=session)
        assert downgraded == free
    step(sessions, runtime_settings, cluster, 1)
    assert all(resource["kind"] == "PersistentVolumeClaim" for resource in cluster.objects.values())


def test_regrant_waits_for_old_pods_before_reusing_pvc(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    tier(sessions, uid, "free")
    cluster.pods = [{"metadata": {"name": "old-revision-pod"}}]
    step(sessions, runtime_settings, cluster, 1)
    tier(sessions, uid, "pro")
    step(sessions, runtime_settings, cluster, 12)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        assert row.status == "suspending" and row.encrypted_api_key is None
    assert not any(v["kind"] == "Service" for v in cluster.objects.values())
    cluster.pods = []
    step(sessions, runtime_settings, cluster, 23)
    step(sessions, runtime_settings, cluster, 24)
    with sessions() as session:
        assert session.get(RuntimeBinding, uid).status == "ready"


def test_runtime_status_is_owned_and_never_contains_connection_material(
    runtime_settings, sessions, accounts
):
    from fastapi.testclient import TestClient

    from mori.main import create_app

    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    with sessions() as session:
        row = session.get(RuntimeBinding, uid)
        key = decrypt_key(runtime_settings, row.encrypted_api_key)
        url = row.base_url
    with TestClient(create_app(runtime_settings)) as client:
        response = client.get("/v1/me/runtime", headers=accounts["alice"]["headers"])
        assert response.status_code == 200 and response.json()["status"] == "ready"
        assert (
            key not in response.text and url not in response.text and "api_key" not in response.text
        )
        bob = client.get("/v1/me/runtime", headers=accounts["bob"]["headers"])
        assert bob.json()["status"] == "not_requested"
        assert (
            client.post("/v1/me/runtime/retry", headers=accounts["bob"]["headers"]).status_code
            == 403
        )
        assert client.get("/v1/me/runtime").status_code == 401


def test_image_changes_require_explicit_safe_upgrade(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    changed = runtime_settings.model_copy(
        update={"runtime_image": "harbor.example/mori/hermes@sha256:" + "b" * 64}
    )
    step(sessions, changed, cluster, 11)
    with sessions() as session:
        assert session.get(RuntimeBinding, uid).error_code == "RUNTIME_CONFIGURATION_CHANGED"
    assert not any(method in {"PATCH", "PUT", "DELETE"} for method, _ in cluster.calls)


def test_provisioning_requires_operator_credentials_and_immutable_image():
    with pytest.raises(ValueError):
        RuntimeSettings(runtime_provisioning_enabled=True)
    with pytest.raises(ValueError):
        RuntimeSettings(runtime_kubernetes_url="http://cluster.local")
    with pytest.raises(ValueError):
        RuntimeSettings(runtime_namespace="../default")


def test_labels_bind_both_owner_and_runtime_identity():
    class Binding:
        user_id = uuid4()
        id = uuid4()

    assert labels(Binding)["mori.app/user-id"] == str(Binding.user_id)
    assert labels(Binding)["mori.app/runtime-id"] == str(Binding.id)


def test_stale_suspension_cannot_delete_regranted_generation(runtime_settings, sessions, accounts):
    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    tier(sessions, uid, "free")
    sync_entitlements(sessions, runtime_settings, NOW + timedelta(seconds=1))
    old_claim = claim_due(sessions, runtime_settings, NOW + timedelta(seconds=1))
    # Another worker takes the expired lease, finishes suspension, and provisions a new grant.
    step(sessions, runtime_settings, cluster, 182)
    tier(sessions, uid, "pro")
    step(sessions, runtime_settings, cluster, 183)
    before = copy.deepcopy(cluster.objects)

    async def stale_request():
        async with Kubernetes(runtime_settings, cluster.transport) as kube:
            with pytest.raises(ApiError, match="RUNTIME_GENERATION_CHANGED"):
                await reconcile(kube, old_claim, runtime_settings)

    asyncio.run(stale_request())
    assert cluster.objects == before


def test_expired_paid_plan_denied_even_without_payment_worker(runtime_settings, sessions, accounts):
    from mori.billing.models import BillingEntitlement, Subscription

    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    cluster = Cluster()
    step(sessions, runtime_settings, cluster)
    with sessions.begin() as session:
        session.add(BillingEntitlement(user_id=uid, admin_granted=False))
        session.add(
            Subscription(
                user_id=uid,
                customer_key="test-expired-customer",
                status="active",
                amount=1000,
                current_period_start=NOW - timedelta(days=31),
                current_period_end=NOW - timedelta(days=1),
            )
        )
    with sessions() as session:
        with pytest.raises(ApiError, match="PRO_REQUIRED"):
            resolve_binding(session, runtime_settings, uid, "pro")
    step(sessions, runtime_settings, cluster, 2)
    with sessions() as session:
        assert session.get(User, uid).tier == "free"
        assert session.get(RuntimeBinding, uid).status == "suspended"


def test_provisioner_publishes_database_heartbeat_independently(sessions, monkeypatch, tmp_path):
    from mori.operations.models import WorkerHeartbeat
    from mori.operations.service import heartbeat
    from mori.runtimes import worker

    async def exercise():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()

        def publish(factory, component, **kwargs):
            heartbeat(factory, component, **kwargs)
            loop.call_soon_threadsafe(stop.set)

        monkeypatch.setattr(worker, "heartbeat", publish)
        monkeypatch.setattr(worker, "Path", lambda _: tmp_path / "pulse")
        await worker.publish_heartbeat(sessions, stop, {"success": True, "error_code": None})

    asyncio.run(exercise())
    with sessions() as session:
        row = session.get(WorkerHeartbeat, "provisioning")
        assert row.seen_at and row.success_at and row.error_code is None
    assert (tmp_path / "pulse").is_file()


def test_existing_operator_assignment_is_not_replaced(runtime_settings, sessions, accounts):
    from mori.config import PrivateRuntime

    uid = accounts["alice"]["user_id"]
    tier(sessions, uid, "pro")
    configured = runtime_settings.model_copy(
        update={
            "chat_private_runtimes": {
                str(uid): PrivateRuntime(
                    base_url="http://existing.private.svc.cluster.local", api_key="old-key"
                )
            }
        }
    )
    cluster = Cluster()
    assert not step(sessions, configured, cluster)
    assert not cluster.calls
    with sessions() as session:
        assert session.get(RuntimeBinding, uid) is None


def test_admin_approval_to_ready_and_revoke_through_public_api(
    runtime_settings, sessions, accounts
):
    from fastapi.testclient import TestClient

    from mori.main import create_app

    uid = accounts["alice"]["user_id"]
    with sessions.begin() as session:
        session.get(User, accounts["bob"]["user_id"]).role = "super_admin"
    cluster = Cluster()
    with TestClient(create_app(runtime_settings)) as client:
        approved = client.post(
            f"/v1/admin/users/{uid}/pro/approve",
            headers=accounts["bob"]["headers"],
            json={"reason": "개인 비서 사용 승인"},
        )
        assert approved.status_code == 200 and approved.json()["tier"] == "pro"
        before = client.get("/v1/me/runtime", headers=accounts["alice"]["headers"])
        assert before.json()["status"] == "pending"
        step(sessions, runtime_settings, cluster)
        ready = client.get("/v1/me/runtime", headers=accounts["alice"]["headers"])
        assert ready.json()["status"] == "ready" and ready.json()["access_allowed"]
        revoked = client.post(
            f"/v1/admin/users/{uid}/pro/revoke",
            headers=accounts["bob"]["headers"],
            json={"reason": "개인 비서 사용 회수"},
        )
        assert revoked.status_code == 200 and revoked.json()["tier"] == "free"
        blocked = client.get("/v1/me/runtime", headers=accounts["alice"]["headers"])
        assert not blocked.json()["access_allowed"]
        step(sessions, runtime_settings, cluster, 1)
        stopped = client.get("/v1/me/runtime", headers=accounts["alice"]["headers"])
        assert stopped.json()["status"] == "suspended" and stopped.json()["storage_retained"]
