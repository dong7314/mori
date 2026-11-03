from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import select, text
from test_poc_organizer_contracts import create

from mori.organizer.models import Reminder, WriteReceipt


def test_restart_resets_progress_origin_and_extension_preserves_it(client, accounts, sessions):
    headers = accounts["alice"]["headers"]
    row = create(
        client,
        accounts,
        "reminders",
        {"title": "휴식", "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat()},
    )
    assert row["started_at"] == row["created_at"]
    url = f"/v1/reminders/{row['id']}"
    yesterday = datetime.now(UTC) - timedelta(days=1)
    with sessions.begin() as session:
        stored = session.get(Reminder, UUID(row["id"]))
        stored.started_at = stored.created_at = yesterday
    cancelled = client.post(url + "/cancel", json={"revision": 1}, headers=headers).json()
    assert datetime.fromisoformat(cancelled["started_at"]) == yesterday
    response = client.post(
        url + "/resume",
        json={
            "revision": 2,
            "target_at": (datetime.now(UTC) + timedelta(minutes=30)).isoformat(),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    resumed = response.json()
    assert resumed["started_at"] == resumed["updated_at"]
    assert datetime.fromisoformat(resumed["created_at"]) == yesterday
    assert datetime.fromisoformat(resumed["started_at"]) > yesterday
    target, started = map(datetime.fromisoformat, [resumed["target_at"], resumed["started_at"]])
    extended = client.post(url + "/extend", json={"revision": 3}, headers=headers).json()
    assert extended["started_at"] == resumed["started_at"]
    assert datetime.fromisoformat(extended["target_at"]) == target + timedelta(minutes=5)
    assert client.get(url, headers=headers).json()["started_at"] == resumed["started_at"]
    assert (
        client.get("/v1/reminders", headers=headers).json()[0]["started_at"]
        == resumed["started_at"]
    )
    with sessions() as session:
        assert session.get(Reminder, UUID(row["id"])).started_at == started


def test_legacy_create_receipt_replays_with_original_start_without_resetting_timer(
    client, accounts, sessions
):
    headers = accounts["alice"]["headers"]
    key = uuid4()
    payload = {"title": "휴식", "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
    row = create(client, accounts, "reminders", payload, key=key)
    with sessions.begin() as session:
        receipt = session.scalar(select(WriteReceipt).where(WriteReceipt.key == key))
        receipt.response = {k: v for k, v in receipt.response.items() if k != "started_at"}
    url = f"/v1/reminders/{row['id']}"
    resumed = client.post(
        url + "/resume",
        json={"revision": 1, "target_at": payload["target_at"]},
        headers=headers,
    ).json()
    replay = client.post(
        "/v1/reminders", json=payload, headers={**headers, "Idempotency-Key": str(key)}
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["started_at"] == row["created_at"]
    current = client.get(url, headers=headers).json()
    assert current["revision"] == 2 and current["started_at"] == resumed["started_at"]


def test_started_at_migration_backfills_existing_reminders(client, accounts, sessions):
    row = create(
        client,
        accounts,
        "reminders",
        {"title": "휴식", "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat()},
    )
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    created = datetime(2026, 1, 1, tzinfo=UTC)
    command.downgrade(config, "0015_chat_attachments")
    try:
        with sessions.begin() as session:
            session.execute(
                text("UPDATE reminders SET created_at = :created WHERE id = :id"),
                {"created": created, "id": UUID(row["id"])},
            )
    finally:
        command.upgrade(config, "head")
    response = client.get(f"/v1/reminders/{row['id']}", headers=accounts["alice"]["headers"])
    assert response.status_code == 200, response.text
    assert datetime.fromisoformat(response.json()["started_at"]) == created
