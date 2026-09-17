from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from mori.auth.models import AccessToken
from mori.main import create_app
from mori.parking.models import ParkingRecord

PATH = "/v1/parking-records"
PARKING = {"floor": "B2", "zone": "C", "spot": "C36"}


def save(client, account, payload=None, key=None):
    return client.post(
        PATH,
        headers={**account["headers"], "Idempotency-Key": str(key or uuid4())},
        json=PARKING if payload is None else payload,
    )


def test_save_and_read_latest_survives_app_restart(client, accounts, settings, sessions):
    # The database may run on another host/VM; compare against its clock, not the client clock.
    with sessions() as session:
        before = session.scalar(select(func.clock_timestamp()))
    created = save(client, accounts["alice"])
    assert created.status_code == 201
    record = created.json()
    assert {name: record[name] for name in PARKING} == PARKING
    recorded_at = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
    with sessions() as session:
        after = session.scalar(select(func.clock_timestamp()))
    assert before <= recorded_at <= after
    assert recorded_at.utcoffset() == timedelta(0)
    assert "user_id" not in record
    assert "idempotency_key" not in record
    assert created.headers["Cache-Control"] == "no-store"

    # A new app/connection pool reads the committed database row, not process memory.
    with TestClient(create_app(settings)) as restarted:
        latest = restarted.get(f"{PATH}/latest", headers=accounts["alice"]["headers"])
    assert latest.status_code == 200
    assert latest.json() == record
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_latest_uses_new_record_and_replay_does_not_move_old_record(client, accounts):
    key = uuid4()
    first = save(client, accounts["alice"], key=key)
    second = save(client, accounts["alice"], {"floor": "B1", "spot": "A12"})
    replay = save(client, accounts["alice"], key=key)
    latest = client.get(f"{PATH}/latest", headers=accounts["alice"]["headers"])
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert latest.json() == second.json()


def test_user_scope_for_reads_and_idempotency_keys(client, accounts):
    key = uuid4()
    alice = save(client, accounts["alice"], key=key)
    empty = client.get(f"{PATH}/latest", headers=accounts["bob"]["headers"])
    assert empty.status_code == 404
    assert empty.json()["error"]["code"] == "PARKING_NOT_FOUND"
    bob = save(client, accounts["bob"], {"spot": "D99"}, key)
    assert bob.status_code == 201
    assert bob.json()["id"] != alice.json()["id"]
    # A client-supplied identity never overrides the authenticated user.
    latest = client.get(
        f"{PATH}/latest",
        params={"user_id": str(accounts["alice"]["user_id"])},
        headers={**accounts["bob"]["headers"], "X-User-ID": str(accounts["alice"]["user_id"])},
    )
    assert latest.json() == bob.json()


def test_reusing_key_with_different_payload_returns_conflict(client, accounts, sessions):
    key = uuid4()
    created = save(client, accounts["alice"], key=key)
    conflict = save(client, accounts["alice"], {"spot": "A10"}, key)
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    latest = client.get(f"{PATH}/latest", headers=accounts["alice"]["headers"])
    assert latest.json() == created.json()
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_equivalent_normalized_payload_is_a_replay(client, accounts):
    key = uuid4()
    first = save(client, accounts["alice"], {"spot": " C36 "}, key)
    replay = save(client, accounts["alice"], {"spot": "C36", "floor": None, "zone": None}, key)
    assert first.status_code == 201
    assert replay.status_code == 200
    assert replay.json() == first.json()


def test_concurrent_retries_only_insert_once(client, accounts, settings, sessions):
    key = uuid4()
    barrier = Barrier(4)

    def request():
        with TestClient(create_app(settings)) as independent_client:
            barrier.wait(timeout=10)
            return save(independent_client, accounts["alice"], key=key)

    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: request(), range(4)))
    assert sorted(response.status_code for response in responses) == [200, 200, 200, 201]
    assert len({response.json()["id"] for response in responses}) == 1
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_concurrent_conflicting_requests_only_accept_one(client, accounts, settings, sessions):
    key = uuid4()
    barrier = Barrier(2)

    def request(spot):
        with TestClient(create_app(settings)) as independent_client:
            barrier.wait(timeout=10)
            return save(independent_client, accounts["alice"], {"spot": spot}, key)

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(request, ["A1", "B2"]))
    assert sorted(response.status_code for response in responses) == [201, 409]
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 1


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"floor": None, "zone": None, "spot": None},
        {"floor": " "},
        {"spot": ""},
        {"floor": "B" * 33},
        {"zone": "C" * 65},
        {"spot": 36},
        {"spot": "C\x0036"},
        {"zone": "C\nD"},
        {"spot": "C36", "user_id": str(uuid4())},
        {"spot": "C36", "recorded_at": "2099-01-01T00:00:00Z"},
    ],
)
def test_invalid_payload_never_writes(client, accounts, sessions, payload):
    response = save(client, accounts["alice"], payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(ParkingRecord)) == 0


@pytest.mark.parametrize("key", [None, "not-a-uuid"])
def test_idempotency_key_required(client, accounts, key):
    headers = dict(accounts["alice"]["headers"])
    if key:
        headers["Idempotency-Key"] = key
    response = client.post(PATH, headers=headers, json=PARKING)
    assert response.status_code == 422


@pytest.mark.parametrize("method,path", [("GET", f"{PATH}/latest"), ("POST", PATH)])
@pytest.mark.parametrize("authorization", [None, "Bearer invalid", "Basic invalid"])
def test_requires_real_authentication(client, method, path, authorization):
    headers = {"Idempotency-Key": str(uuid4())}
    if authorization:
        headers["Authorization"] = authorization
    response = client.request(method, path, headers=headers, json=PARKING)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("field", ["expires_at", "revoked_at"])
def test_expired_and_revoked_tokens_are_rejected(client, accounts, sessions, field):
    with sessions.begin() as session:
        session.execute(
            update(AccessToken)
            .where(AccessToken.id == accounts["alice"]["token_id"])
            .values({field: datetime.now(UTC) - timedelta(seconds=1)})
        )
    response = save(client, accounts["alice"])
    assert response.status_code == 401
