from datetime import datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text


def create(client, accounts, path, payload):
    return client.post(
        "/v1/" + path,
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
    )


def event(starts_at, ends_at, **extra):
    return {"title": "경계 일정", "starts_at": starts_at, "ends_at": ends_at, **extra}


@pytest.mark.parametrize(
    "payload",
    [
        event("0001-01-01T00:00:00+01:00", "0001-01-02T00:00:00+01:00"),
        event("9999-12-31T22:58:00-01:00", "9999-12-31T23:59:00-01:00"),
        event(
            "0001-01-01T00:00:00Z",
            "0001-01-02T00:00:00Z",
            all_day=True,
            timezone="America/New_York",
        ),
        event("9999-12-30T15:00:00Z", "9999-12-31T15:00:00Z", all_day=True, timezone="Asia/Seoul"),
    ],
)
def test_event_rejects_unrepresentable_utc_or_all_day_local_date(
    client, accounts, sessions, payload
):
    response = create(client, accounts, "calendar/events", payload)
    assert response.status_code == 422, response.text
    with sessions() as session:
        assert session.scalar(text("SELECT count(*) FROM calendar_events")) == 0
        assert session.scalar(text("SELECT count(*) FROM write_receipts")) == 0


@pytest.mark.parametrize(
    "path,payload",
    [
        ("calendar/events", event("0001-01-01T01:00:00+01:00", "0001-01-02T01:00:00+01:00")),
        ("calendar/events", event("9999-12-31T22:58:00-01:00", "9999-12-31T22:59:00-01:00")),
        (
            "calendar/events",
            event(
                "0001-01-01T01:00:00+01:00",
                "0001-01-02T01:00:00+01:00",
                all_day=True,
                timezone="UTC",
            ),
        ),
        ("reminders", {"title": "경계 알림", "target_at": "9999-12-31T22:59:00-01:00"}),
    ],
)
def test_representable_extreme_dates_survive_create_and_read(client, accounts, path, payload):
    response = create(client, accounts, path, payload)
    assert response.status_code == 201, response.text
    row = response.json()
    detail = client.get("/v1/" + path + "/" + row["id"], headers=accounts["alice"]["headers"])
    assert detail.status_code == 200, detail.text
    for name in ("starts_at", "ends_at", "target_at"):
        if name in payload:
            assert datetime.fromisoformat(detail.json()[name]) == datetime.fromisoformat(
                payload[name]
            )


@pytest.mark.parametrize("operation", ["create", "replace", "resume"])
def test_reminder_rejects_target_that_would_poison_database_reads(
    client, accounts, sessions, operation
):
    payload = {"title": "정상 알림", "target_at": "9999-12-31T23:50:00Z"}
    headers = accounts["alice"]["headers"]
    bad_target = "9999-12-31T23:59:00-01:00"
    if operation == "create":
        response = create(client, accounts, "reminders", {**payload, "target_at": bad_target})
    else:
        original = create(client, accounts, "reminders", payload).json()
        url = "/v1/reminders/" + original["id"]
        if operation == "replace":
            response = client.put(
                url, json={**payload, "target_at": bad_target, "revision": 1}, headers=headers
            )
        else:
            response = client.post(
                url + "/resume", json={"target_at": bad_target, "revision": 1}, headers=headers
            )
        detail = client.get(url, headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["revision"] == 1
        assert detail.json()["target_at"] == original["target_at"]
    assert response.status_code == 422, response.text
    listed = client.get("/v1/reminders", headers=headers)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == (0 if operation == "create" else 1)
    with sessions() as session:
        assert session.scalar(text("SELECT count(*) FROM reminders")) == (
            0 if operation == "create" else 1
        )


def test_invalid_event_replacement_preserves_saved_interval(client, accounts):
    original = create(
        client, accounts, "calendar/events", event("2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z")
    ).json()
    url = "/v1/calendar/events/" + original["id"]
    response = client.put(
        url,
        json={**event("9999-12-31T22:58:00-01:00", "9999-12-31T23:59:00-01:00"), "revision": 1},
        headers=accounts["alice"]["headers"],
    )
    assert response.status_code == 422, response.text
    detail = client.get(url, headers=accounts["alice"]["headers"])
    assert detail.status_code == 200, detail.text
    assert detail.json() == original


@pytest.mark.parametrize(
    "target,minutes,expected",
    [
        ("9999-12-31T23:59:00Z", 5, 422),
        ("9999-12-31T23:54:00Z", 5, 200),
    ],
)
def test_reminder_extension_checks_result_without_losing_current_timer(
    client, accounts, target, minutes, expected
):
    original = create(
        client, accounts, "reminders", {"title": "마지막 알림", "target_at": target}
    ).json()
    headers = accounts["alice"]["headers"]
    url = "/v1/reminders/" + original["id"]
    cancelled = client.post(url + "/cancel", json={"revision": 1}, headers=headers).json()
    response = client.post(
        url + "/extend", json={"revision": 2, "minutes": minutes}, headers=headers
    )
    assert response.status_code == expected, response.text
    detail = client.get(url, headers=headers)
    assert detail.status_code == 200, detail.text
    if expected == 422:
        assert response.json()["error"]["code"] == "INVALID_REMINDER_TARGET"
        assert detail.json() == cancelled
    else:
        assert detail.json()["target_at"] == "9999-12-31T23:59:00Z"
        assert detail.json()["revision"] == 3
        assert not detail.json()["cancelled"]


@pytest.mark.parametrize(
    "path,table,payload,bad,model",
    [
        (
            "reminders",
            "reminders",
            {"title": "기존 알림", "target_at": "9999-12-31T23:50:00Z"},
            {"target_at": "9999-12-31T23:59:00-01:00"},
            "ReminderWrite",
        ),
        (
            "calendar/events",
            "calendar_events",
            event("2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
            {"starts_at": "9999-12-31T22:58:00-01:00", "ends_at": "9999-12-31T23:59:00-01:00"},
            "EventWrite",
        ),
    ],
)
def test_legacy_datetime_receipt_replays_and_owned_put_can_repair_row(
    client, accounts, sessions, path, table, payload, bad, model
):
    import hashlib
    import json

    from mori.organizer import schemas

    headers = accounts["alice"]["headers"]
    key = uuid4()
    response = client.post(
        "/v1/" + path, json=payload, headers={**headers, "Idempotency-Key": str(key)}
    )
    assert response.status_code == 201, response.text
    original = response.json()
    legacy_payload = {**payload, **bad}
    legacy_response = {**original, **bad}
    # Reproduce data that older versions accepted, including their create receipt.
    with sessions.begin() as session:
        assignments = ", ".join(f"{name} = CAST(:{name} AS timestamptz)" for name in bad)
        session.execute(
            text(f"UPDATE {table} SET {assignments} WHERE id = :id"),
            {**bad, "id": UUID(original["id"])},
        )
        session.execute(
            text(
                "UPDATE write_receipts SET request_hash = :digest, "
                "response = CAST(:response AS jsonb) WHERE key = :key"
            ),
            {
                "digest": hashlib.sha256(
                    getattr(schemas, model)
                    .model_validate(legacy_payload)
                    .model_dump_json()
                    .encode()
                ).hexdigest(),
                "response": json.dumps(legacy_response),
                "key": key,
            },
        )
    replay = client.post(
        "/v1/" + path, json=legacy_payload, headers={**headers, "Idempotency-Key": str(key)}
    )
    assert replay.status_code == 201, replay.text
    assert replay.json() == legacy_response
    url = "/v1/" + path + "/" + original["id"]
    assert (
        client.put(
            url, json={**payload, "revision": 1}, headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    assert client.put(url, json={**payload, "revision": 2}, headers=headers).status_code == 409
    repaired = client.put(url, json={**payload, "revision": 1}, headers=headers)
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["revision"] == 2
    detail = client.get(url, headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json() == repaired.json()
    if path == "reminders":
        listed = client.get("/v1/reminders", headers=headers)
    else:
        listed = client.get(
            "/v1/calendar/events",
            params={"from": payload["starts_at"], "until": payload["ends_at"]},
            headers=headers,
        )
    assert listed.status_code == 200, listed.text
    assert listed.json() == [repaired.json()]
    # A historical receipt still describes its original creation after repair.
    assert (
        client.post(
            "/v1/" + path, json=legacy_payload, headers={**headers, "Idempotency-Key": str(key)}
        ).json()
        == legacy_response
    )
