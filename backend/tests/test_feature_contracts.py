from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import text
from test_chat import SECRET, Agent, conversation, events

from mori.chat.router import get_chat_transport
from mori.features import service
from mori.features.models import FeatureResult
from mori.features.schemas import FeatureCreate
from mori.organizer.models import UserPreference

ICONS = (
    "note",
    "file",
    "book",
    "news",
    "chart",
    "chat",
    "calendar",
    "clock",
    "bell",
    "sun",
    "moon",
    "spark",
    "home",
    "leaf",
    "heart",
    "car",
    "pin",
    "compass",
)


@pytest.fixture
def agent(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = True
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    mock = Agent()
    client.app.dependency_overrides[get_chat_transport] = lambda: httpx.MockTransport(mock)
    return mock


def create(client, accounts, payload, *, key=None):
    return client.post(
        "/v1/features",
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def freeze_clock(monkeypatch, instant):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)

    monkeypatch.setattr(service, "datetime", FrozenDatetime)


@pytest.mark.parametrize("icon", ICONS)
def test_poc_icons_round_trip(client, accounts, icon):
    response = create(client, accounts, {"work": "메모 정리", "icon": icon})
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["icon"] == icon
    assert (
        client.get("/v1/features/" + row["id"], headers=accounts["alice"]["headers"]).json()["icon"]
        == icon
    )


def test_reference_alias_conflicts_and_canonical_idempotency(client, accounts):
    key = uuid4()
    created = create(client, accounts, {"content": "참고 원문", "icon": "book"}, key=key)
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["reference"] == "참고 원문" and "content" not in row
    assert (
        create(client, accounts, {"reference": "참고 원문", "icon": "book"}, key=key).json() == row
    )
    assert (
        create(client, accounts, {"reference": "같은 원문", "content": " 같은 원문 "}).status_code
        == 201
    )
    assert create(client, accounts, {"reference": "원문 A", "content": "원문 B"}).status_code == 422
    url = "/v1/features/" + row["id"]
    updated = client.put(
        url, json={"revision": 1, "content": "바뀐 원문"}, headers=accounts["alice"]["headers"]
    )
    assert updated.status_code == 200 and updated.json()["reference"] == "바뀐 원문"
    assert (
        client.get(url + "/versions/1", headers=accounts["alice"]["headers"]).json()["reference"]
        == "참고 원문"
    )


@pytest.mark.parametrize(
    "instant,expected",
    [
        ("2026-11-01T00:59:00+00:00", "2026-10-31"),
        ("2026-11-01T01:00:00+00:00", "2026-11-01"),
    ],
)
def test_date_less_once_uses_next_occurrence_in_user_timezone(
    client, accounts, sessions, monkeypatch, instant, expected
):
    freeze_clock(monkeypatch, datetime.fromisoformat(instant))
    with sessions.begin() as session:
        session.add(
            UserPreference(
                user_id=accounts["alice"]["user_id"], data={"timezone": "America/Los_Angeles"}
            )
        )
    key = uuid4()
    payload = {"work": "정리", "schedule": {"time": "18:00", "repeat": "once"}}
    response = create(client, accounts, payload, key=key)
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["schedule"] == {
        "time": "18:00",
        "timezone": "America/Los_Angeles",
        "repeat": "once",
        "date": expected,
    }
    freeze_clock(monkeypatch, datetime(2027, 1, 1, tzinfo=UTC))
    assert create(client, accounts, payload, key=key).json() == row


def test_once_edit_preserves_date_and_timezone_until_explicit_change(client, accounts, monkeypatch):
    h = accounts["alice"]["headers"]
    row = create(
        client,
        accounts,
        {
            "work": "정리",
            "schedule": {
                "time": "19:00",
                "repeat": "once",
                "date": "2026-01-01",
                "timezone": "UTC",
            },
        },
    ).json()
    freeze_clock(monkeypatch, datetime(2027, 1, 1, tzinfo=UTC))
    url = "/v1/features/" + row["id"]
    changed = client.put(
        url,
        json={"revision": 1, "work": "정리 수정", "schedule": {"time": "20:00", "repeat": "once"}},
        headers=h,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["schedule"]["date"] == "2026-01-01"
    assert changed.json()["schedule"]["timezone"] == "UTC"
    changed = client.put(
        url,
        json={
            "revision": 2,
            "work": "정리 수정",
            "schedule": {"time": "20:00", "repeat": "once", "date": "2027-02-01"},
        },
        headers=h,
    )
    assert changed.json()["schedule"]["date"] == "2027-02-01"
    with pytest.raises(ValidationError):
        FeatureCreate(schedule={"time": "20:00", "repeat": "daily", "date": "2027-02-01"})


def test_markdown_items_do_not_invent_tasks_from_prose_or_code():
    text = "설명 문장\n- [ ] 우산 챙기기\n* [x] 문 잠그기\n1. 메모 확인\n```md\n- 코드 안\n```"
    items = service.result_items(text)
    assert [(item["text"], item["done"]) for item in items] == [
        ("우산 챙기기", False),
        ("문 잠그기", True),
        ("메모 확인", False),
    ]
    assert len({UUID(item["id"]) for item in items}) == 3
    assert service.result_items("할 일인지 알 수 없는 일반 답변") == []
    assert service.result_items("- [ ]\n- [x]   \n* * *\n- - -") == []
    assert service.result_items("```md\n```not a closing fence\n- 코드 안\n```") == []


def test_next_once_skips_nonexistent_dst_time():
    from mori.features.schemas import Schedule

    schedule = Schedule(time="02:30", timezone="America/Los_Angeles", repeat="once")
    result = service.normalize_schedule(
        None, None, schedule, now=datetime(2027, 3, 14, 8, tzinfo=UTC)
    )
    assert result["date"] == "2027-03-15"


def execute_feature(client, accounts, agent, *, text):
    h = accounts["alice"]["headers"]
    feature = create(client, accounts, {"work": "오늘 메모를 정리해줘"}).json()
    cid, key = conversation(client, accounts), str(uuid4())
    agent.decision = {"action": "reply", "reply": text}
    body = {"message": "실행해줘", "feature_id": feature["id"]}
    headers = {**h, "Idempotency-Key": key}
    url = f"/v1/conversations/{cid}/messages"
    observed = events(client.post(url, json=body, headers=headers))
    assert observed[-1]["type"] == "run.completed", observed
    result = next(event for event in observed if event["type"] == "result.saved")
    return result["detail_url"], (url, body, headers, observed), feature


def test_items_persist_with_stable_ids_revisions_ownership_and_replay(client, accounts, agent):
    h = accounts["alice"]["headers"]
    original = "오늘의 할 일\n- [ ] 우산 챙기기\n- [x] 문 잠그기"
    url, replay, feature = execute_feature(client, accounts, agent, text=original)
    row = client.get(url, headers=h).json()
    assert row["text"] == original and len(row["items"]) == 2
    assert [(item["text"], item["done"]) for item in row["items"]] == [
        ("우산 챙기기", False),
        ("문 잠그기", True),
    ]
    patch_url = url + "/items/" + row["items"][0]["id"]
    changed = client.patch(patch_url, json={"revision": 1, "done": True}, headers=h)
    assert changed.status_code == 200, changed.text
    edited = changed.json()
    assert edited["revision"] == 2 and edited["items"][0]["done"] is True
    assert [item["id"] for item in edited["items"]] == [item["id"] for item in row["items"]]
    assert edited["text"] == original
    assert client.get(url, headers=h).json() == edited
    assert client.get(f"/v1/features/{feature['id']}/results", headers=h).json()[0] == edited
    assert (
        client.patch(patch_url, json={"revision": 1, "done": False}, headers=h).status_code == 409
    )
    assert (
        client.patch(
            patch_url, json={"revision": 2, "done": False}, headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    assert client.patch(patch_url, json={"revision": 2, "done": False}).status_code == 401
    assert (
        client.patch(
            url + "/items/" + str(uuid4()), json={"revision": 2, "done": True}, headers=h
        ).status_code
        == 404
    )
    assert (
        client.patch(patch_url, json={"revision": 2, "done": "false"}, headers=h).status_code == 422
    )
    again = client.patch(patch_url, json={"revision": 2, "done": True}, headers=h)
    assert again.json() == edited
    send_url, body, headers, observed = replay
    assert events(client.post(send_url, json=body, headers=headers)) == observed
    assert client.get(url, headers=h).json() == edited


def test_old_text_results_remain_readable_with_empty_items(client, accounts, agent, sessions):
    url, _, _ = execute_feature(client, accounts, agent, text="문장으로만 작성한 결과")
    result_id = UUID(url.rsplit("/", 1)[-1])
    with sessions.begin() as session:
        row = session.get(FeatureResult, result_id)
        legacy = {
            "id": row.id,
            "user_id": row.user_id,
            "feature_id": row.feature_id,
            "feature_version": row.feature_version,
            "run_id": row.run_id,
            "title": row.title,
            "text": row.text,
        }
        session.delete(row)
        session.flush()
        # An old writer omits items; exercise the database default, not the ORM default.
        session.execute(
            text("""
                INSERT INTO feature_results
                    (id, user_id, feature_id, feature_version, run_id, title, text, revision)
                VALUES
                    (:id, :user_id, :feature_id, :feature_version, :run_id, :title, :text, 1)
                """),
            legacy,
        )
    stored = client.get(url, headers=accounts["alice"]["headers"]).json()
    assert stored["items"] == [] and stored["text"] == "문장으로만 작성한 결과"
