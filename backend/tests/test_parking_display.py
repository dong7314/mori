import hashlib
import json
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from pydantic import ValidationError
from sqlalchemy import select, text
from test_chat import agent as agent  # pytest fixture
from test_chat import conversation, events, send

from mori.parking.models import ParkingRecord
from mori.parking.schemas import ParkingCreate


def save(client, accounts, payload, key=None):
    return client.post(
        "/v1/parking-records",
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def cards(client, accounts, at, hours=0, who="alice"):
    result = client.get(
        "/v1/dashboard", params={"at": at, "hours": hours}, headers=accounts[who]["headers"]
    )
    assert result.status_code == 200, result.text
    return [item for group in result.json()["groups"] for item in group["items"]]


def fixed_record_time(sessions, rid, at="2026-09-01T00:00:00+00:00"):
    with sessions.begin() as session:
        session.get(ParkingRecord, UUID(rid)).recorded_at = datetime.fromisoformat(at)


def test_plain_location_is_always_visible_stable_and_owned(client, accounts, sessions):
    created = save(client, accounts, {"spot": "B16"})
    assert created.status_code == 201
    row = created.json()
    assert (row["purpose"], row["display_mode"], row["display_schedule"]) == (
        "external",
        "always",
        None,
    )
    fixed_record_time(sessions, row["id"])
    first = cards(client, accounts, "2026-10-01T02:00:00+09:00")
    later = cards(client, accounts, "2026-10-03T18:00:00+09:00", 24)
    assert len(first) == len(later) == 1
    assert first[0]["key"] == later[0]["key"]
    assert first[0]["show_until"] is None and first[0]["current"]
    assert first[0]["title"] == "외부 주차 위치"
    assert cards(client, accounts, "2026-10-01T02:00:00+09:00", who="bob") == []
    assert cards(client, accounts, "2026-08-31T02:00:00+09:00") == []
    second = save(client, accounts, {"spot": "C12", "purpose": "commute"}).json()
    fixed_record_time(sessions, second["id"], "2026-09-02T00:00:00+00:00")
    latest = cards(client, accounts, "2026-10-03T18:00:00+09:00")
    assert len(latest) == 1 and latest[0]["resource_id"] == second["id"]
    assert latest[0]["title"] == "출근용 주차 위치"


def test_scheduled_parking_weekdays_boundaries_and_midnight(client, accounts, sessions):
    payload = {
        "spot": "A1",
        "purpose": "commute",
        "display_mode": "scheduled",
        "display_schedule": {"time": "23:30", "days": [3], "duration_minutes": 120},
    }
    row = save(client, accounts, payload).json()
    fixed_record_time(sessions, row["id"])
    assert cards(client, accounts, "2026-10-01T23:29:00+09:00") == []
    future = cards(client, accounts, "2026-10-01T22:00:00+09:00", 3)
    assert len(future) == 1 and not future[0]["current"]
    current = cards(client, accounts, "2026-10-02T00:30:00+09:00")
    assert len(current) == 1 and current[0]["key"] == future[0]["key"]
    assert current[0]["availability"] == "available" and current[0]["action"] == "display"
    assert cards(client, accounts, "2026-10-02T01:30:00+09:00") == []
    assert cards(client, accounts, "2026-10-02T23:30:00+09:00") == []
    # Saving during a display interval starts showing immediately, not the following week.
    fixed_record_time(sessions, row["id"], "2026-10-01T15:00:00+00:00")
    assert cards(client, accounts, "2026-10-02T00:30:00+09:00")[0]["show_from"] == (
        "2026-10-01T15:00:00Z"
    )


def test_display_options_are_part_of_idempotency(client, accounts):
    key = uuid4()
    payload = {
        "spot": "A1",
        "display_mode": "scheduled",
        "display_schedule": {"time": "08:30", "days": [4, 0]},
    }
    first = save(client, accounts, payload, key)
    assert first.status_code == 201
    reordered = {**payload, "display_schedule": {"time": "08:30", "days": [0, 4]}}
    replay = save(client, accounts, reordered, key)
    assert replay.status_code == 200 and replay.json() == first.json()
    assert save(client, accounts, {"spot": "A1"}, key).status_code == 409
    assert save(client, accounts, {**payload, "purpose": "commute"}, key).status_code == 409


@pytest.mark.parametrize(
    "options",
    [
        {"purpose": "unknown"},
        {"display_mode": "paused"},
        {"display_mode": "scheduled"},
        {"display_schedule": {"time": "08:00"}},
        *[
            {"display_mode": "scheduled", "display_schedule": schedule}
            for schedule in (
                {"time": "25:00"},
                {"time": "08:00", "days": []},
                {"time": "08:00", "days": [0, 0]},
                {"time": "08:00", "days": [7]},
                {"time": "08:00", "days": [True]},
                {"time": "08:00", "days": ["1"]},
                {"time": "08:00", "timezone": "No/Zone"},
                {"time": "08:00", "duration_minutes": 0},
                {"time": "08:00", "duration_minutes": 1441},
            )
        ],
    ],
)
def test_invalid_display_contract(options):
    with pytest.raises(ValidationError):
        ParkingCreate.model_validate({"spot": "A1", **options})


def test_migration_preserves_legacy_record_context_hash_and_readiness(
    client,
    accounts,
    sessions,
    database_url,
):
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    key, rid = uuid4(), uuid4()
    payload = {"floor": None, "zone": None, "spot": "old"}
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    command.downgrade(config, "0006_account_settings")
    try:
        assert client.get("/health/ready").status_code == 503
        with sessions.begin() as session:
            session.execute(
                text(
                    "INSERT INTO parking_records (id,user_id,spot,idempotency_key,request_hash) "
                    "VALUES (:id,:user_id,:spot,:key,:hash)"
                ),
                {
                    "id": rid,
                    "user_id": accounts["alice"]["user_id"],
                    "spot": "old",
                    "key": key,
                    "hash": digest,
                },
            )
    finally:
        command.upgrade(config, "head")
    assert client.get("/health/ready").status_code == 200
    replay = save(client, accounts, {"spot": "old"}, key)
    assert replay.status_code == 200 and replay.json()["id"] == str(rid)
    assert replay.json()["purpose"] == "commute"
    assert replay.json()["display_mode"] == "scheduled"
    assert replay.json()["display_schedule"] is None
    with sessions() as session:
        assert session.scalar(select(ParkingRecord.request_hash)) == digest


def test_chat_parking_saves_display_contract_and_reports_actual_mode(client, accounts, agent):
    agent.decision = {
        "action": "parking_save",
        "parking": {
            "spot": "D4",
            "purpose": "commute",
            "display_mode": "scheduled",
            "display_schedule": {"time": "08:30"},
        },
    }
    observed = events(send(client, accounts, conversation(client, accounts)))
    result = next(x["result"] for x in observed if x["type"] == "action.completed")
    assert result["display_schedule"]["time"] == "08:30"
    assert "08:30" in next(x["text"] for x in observed if x["type"] == "message.completed")
    assert observed[-1]["type"] == "run.completed"
