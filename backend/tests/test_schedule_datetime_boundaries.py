from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from mori.automation.models import AutomationScheduleState
from mori.automation.scheduler import claim_job, enqueue_due, next_occurrence
from mori.features.models import Feature
from mori.features.schemas import Schedule
from mori.features.service import save_version
from mori.organizer.models import UserPreference

INVALID_SCHEDULES = [
    {"time": "00:00", "repeat": "once", "date": "0001-01-01", "timezone": "Asia/Seoul"},
    {
        "time": "23:59",
        "repeat": "once",
        "date": "9999-12-31",
        "timezone": "America/New_York",
    },
]


@pytest.mark.parametrize("schedule", INVALID_SCHEDULES)
def test_unrepresentable_schedule_is_rejected_before_storage(client, accounts, sessions, schedule):
    response = client.post(
        "/v1/features",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
        json={"work": "예약 정리", "schedule": schedule},
    )
    assert response.status_code == 422, response.text
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Feature)) == 0


def add_feature(sessions, accounts, now, schedule, owner="alice"):
    with sessions.begin() as session:
        feature = Feature(
            user_id=accounts[owner]["user_id"],
            title="예약 정리",
            description="",
            work="오늘 메모 정리",
            reference="",
            icon="note",
            status="active",
            updated_at=now - timedelta(minutes=1),
            schedule=schedule,
        )
        session.add(feature)
        session.flush()
        save_version(session, feature)
        return feature.id


@pytest.mark.parametrize("schedule", INVALID_SCHEDULES)
def test_legacy_schedule_remains_readable_isolated_and_repairable(
    client, sessions, accounts, schedule
):
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    invalid_id = add_feature(sessions, accounts, now, schedule)
    valid_schedule = {
        "time": now.strftime("%H:%M"),
        "timezone": "UTC",
        "repeat": "once",
        "date": now.date().isoformat(),
    }
    valid_id = add_feature(sessions, accounts, now, valid_schedule, owner="bob")
    headers = accounts["alice"]["headers"]
    path = f"/v1/features/{invalid_id}"
    listing = client.get("/v1/features", headers=headers)
    detail = client.get(path, headers=headers)
    version = client.get(path + "/versions/1", headers=headers)
    assert listing.status_code == detail.status_code == version.status_code == 200
    assert listing.json()[0]["schedule"] == detail.json()["schedule"] == schedule
    assert version.json()["schedule"] == schedule
    assert client.get("/v1/dashboard?hours=24", headers=headers).status_code == 200
    assert enqueue_due(sessions, now=now) == 1
    assert enqueue_due(sessions, now=now) == 0
    claim = claim_job(sessions, now=now)
    assert claim is not None and claim.feature_id == valid_id
    with sessions() as session:
        feature = session.get(Feature, invalid_id)
        state = session.get(AutomationScheduleState, invalid_id)
        assert state.feature_revision == feature.revision and state.next_at is None
    target = now + timedelta(minutes=1)
    fixed_schedule = {
        **valid_schedule,
        "time": target.strftime("%H:%M"),
        "date": target.date().isoformat(),
    }
    repaired = client.put(
        path,
        headers=headers,
        json={
            "revision": detail.json()["revision"],
            "work": "정상 예약",
            "schedule": fixed_schedule,
        },
    )
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["schedule"] == fixed_schedule
    assert client.get(path + "/versions/1", headers=headers).json()["schedule"] == schedule
    assert enqueue_due(sessions, now=target) == 1
    recovered = claim_job(sessions, now=target)
    assert recovered is not None and recovered.feature_id == invalid_id


@pytest.mark.parametrize(
    ("date", "time", "zone"),
    [
        ("0001-01-01", "00:00", "UTC"),
        ("0001-01-01", "09:00", "Asia/Seoul"),
        ("9999-12-31", "00:00", "America/New_York"),
        ("9999-12-31", "23:59", "UTC"),
    ],
)
def test_representable_boundary_dates_remain_supported(date, time, zone):
    schedule = {"time": time, "repeat": "once", "date": date, "timezone": zone}
    assert Schedule.model_validate(schedule).date.isoformat() == date
    instant = next_occurrence(schedule, datetime.now(UTC))
    assert (instant is None) == (date == "0001-01-01")


@pytest.mark.parametrize(
    ("zone", "date", "time", "status"),
    [
        ("UTC", "0001-01-01", "00:00", 201),
        ("America/New_York", "9999-12-31", "23:59", 422),
    ],
)
def test_omitted_timezone_is_validated_after_user_preference(
    client, sessions, accounts, zone, date, time, status
):
    with sessions.begin() as session:
        session.add(UserPreference(user_id=accounts["alice"]["user_id"], data={"timezone": zone}))
    response = client.post(
        "/v1/features",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
        json={"work": "예약 정리", "schedule": {"time": time, "repeat": "once", "date": date}},
    )
    assert response.status_code == status, response.text
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Feature)) == (status == 201)
    if status == 201:
        assert response.json()["schedule"]["timezone"] == zone


@pytest.mark.parametrize(
    ("zone", "date", "time", "status"),
    [
        ("UTC", "0001-01-01", "00:00", 200),
        ("America/New_York", "9999-12-31", "23:59", 422),
    ],
)
def test_omitted_timezone_is_validated_after_previous_schedule(
    client, accounts, zone, date, time, status
):
    headers = accounts["alice"]["headers"]
    created = client.post(
        "/v1/features",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={
            "work": "예약 정리",
            "schedule": {"time": "09:00", "repeat": "daily", "timezone": zone},
        },
    )
    assert created.status_code == 201
    path = f"/v1/features/{created.json()['id']}"
    changed = client.put(
        path,
        headers=headers,
        json={
            "revision": 1,
            "work": "예약 변경",
            "schedule": {"time": time, "repeat": "once", "date": date},
        },
    )
    assert changed.status_code == status, changed.text
    current = client.get(path, headers=headers).json()
    if status == 200:
        assert current["schedule"]["timezone"] == zone
        assert current["revision"] == 2
    else:
        assert current["schedule"] == created.json()["schedule"]
        assert current["revision"] == 1
