from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from test_chat import agent as agent
from test_chat import conversation, events, send

from mori.organizer.models import Reminder


def create(client, accounts, path, payload, *, who="alice", key=None):
    response = client.post(
        "/v1/" + path,
        json=payload,
        headers={**accounts[who]["headers"], "Idempotency-Key": str(key or uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json()


def reminder(client, accounts):
    return create(
        client,
        accounts,
        "reminders",
        {"title": "휴식", "target_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat()},
    )


def test_resume_cancelled_reminder_keeps_identity_and_rejects_stale_or_past(client, accounts):
    headers = accounts["alice"]["headers"]
    row = reminder(client, accounts)
    url = "/v1/reminders/" + row["id"]
    assert client.post(url + "/cancel", json={"revision": 1}, headers=headers).json()["cancelled"]
    past = client.post(
        url + "/resume",
        json={"revision": 2, "target_at": "2000-01-01T00:00:00Z"},
        headers=headers,
    )
    assert past.status_code == 422 and past.json()["error"]["code"] == "REMINDER_IN_PAST"
    unchanged = client.get(url, headers=headers).json()
    assert unchanged["cancelled"] and unchanged["revision"] == 2
    payload = {
        "revision": 2,
        "target_at": (datetime.now(UTC) + timedelta(minutes=30)).isoformat(),
    }
    response = client.post(url + "/resume", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    resumed = response.json()
    assert resumed["id"] == row["id"] and resumed["revision"] == 3
    assert not resumed["cancelled"] and resumed["delivery_status"] == "not_configured"
    assert datetime.fromisoformat(resumed["target_at"]) == datetime.fromisoformat(
        payload["target_at"]
    )
    assert client.post(url + "/resume", json=payload, headers=headers).status_code == 409
    assert client.post(url + "/extend", json={"revision": 2}, headers=headers).status_code == 409


def test_extend_resumes_and_adds_five_minutes_to_future_target(client, accounts):
    headers = accounts["alice"]["headers"]
    row = reminder(client, accounts)
    url = "/v1/reminders/" + row["id"]
    client.post(url + "/cancel", json={"revision": 1}, headers=headers)
    response = client.post(url + "/extend", json={"revision": 2}, headers=headers)
    assert response.status_code == 200, response.text
    extended = response.json()
    assert extended["id"] == row["id"] and extended["revision"] == 3
    assert not extended["cancelled"]
    assert datetime.fromisoformat(extended["target_at"]) == datetime.fromisoformat(
        row["target_at"]
    ) + timedelta(minutes=5)


def test_extend_elapsed_reminder_uses_server_time(client, accounts, sessions):
    headers = accounts["alice"]["headers"]
    row = reminder(client, accounts)
    with sessions.begin() as session:
        session.get(Reminder, UUID(row["id"])).target_at = datetime.now(UTC) - timedelta(hours=1)
    response = client.post(
        f"/v1/reminders/{row['id']}/extend",
        json={"revision": 1, "minutes": 10},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    extended = response.json()
    assert datetime.fromisoformat(extended["target_at"]) == datetime.fromisoformat(
        extended["updated_at"]
    ) + timedelta(minutes=10)


@pytest.mark.parametrize("action", ["resume", "extend"])
def test_reminder_actions_require_owner_and_live_record(client, accounts, action):
    row = reminder(client, accounts)
    url = f"/v1/reminders/{row['id']}"
    payload = {"revision": 1}
    if action == "resume":
        payload["target_at"] = row["target_at"]
    assert client.post(url + "/" + action, json=payload).status_code == 401
    assert (
        client.post(
            url + "/" + action, json=payload, headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    headers = accounts["alice"]["headers"]
    assert client.delete(url, params={"revision": 1}, headers=headers).status_code == 200
    assert client.post(url + "/" + action, json=payload, headers=headers).status_code == 404


@pytest.mark.parametrize("minutes", [0, -1, 1441])
def test_extend_rejects_invalid_intervals(client, accounts, minutes):
    row = reminder(client, accounts)
    response = client.post(
        f"/v1/reminders/{row['id']}/extend",
        json={"revision": 1, "minutes": minutes},
        headers=accounts["alice"]["headers"],
    )
    assert response.status_code == 422


def test_concurrent_extensions_apply_only_once_per_revision(client, accounts):
    row = reminder(client, accounts)
    url = f"/v1/reminders/{row['id']}/extend"

    def extend():
        return client.post(url, json={"revision": 1}, headers=accounts["alice"]["headers"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: extend(), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 409]
    updated = next(response.json() for response in responses if response.status_code == 200)
    assert datetime.fromisoformat(updated["target_at"]) == datetime.fromisoformat(
        row["target_at"]
    ) + timedelta(minutes=5)


def test_manual_parking_stays_queryable_without_dashboard_projection(client, accounts):
    headers = accounts["alice"]["headers"]
    key = uuid4()
    payload = {"spot": "B16", "purpose": "commute", "display_mode": "manual"}
    row = create(client, accounts, "parking-records", payload, key=key)
    assert row["display_mode"] == "manual" and row["display_schedule"] is None
    assert client.get("/v1/parking-records/latest", headers=headers).json()["id"] == row["id"]
    for hours in (0, 3, 5, 24):
        response = client.get("/v1/dashboard", params={"hours": hours}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["count"] == 0
    conflict = client.post(
        "/v1/parking-records",
        json={**payload, "display_mode": "always"},
        headers={**headers, "Idempotency-Key": str(key)},
    )
    assert conflict.status_code == 409
    invalid = client.post(
        "/v1/parking-records",
        json={**payload, "display_schedule": {"time": "09:00"}},
        headers={**headers, "Idempotency-Key": str(uuid4())},
    )
    assert invalid.status_code == 422


def test_chat_manual_parking_saves_without_claiming_dashboard_display(client, accounts, agent):
    agent.decision = {
        "action": "parking_save",
        "parking": {"spot": "C12", "display_mode": "manual"},
    }
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.completed"
    saved = next(item["result"] for item in observed if item["type"] == "action.completed")
    assert saved["display_mode"] == "manual" and saved["display_schedule"] is None
    answer = next(item["text"] for item in observed if item["type"] == "message.completed")
    assert "기능" in answer and "계속 표시" not in answer
    headers = accounts["alice"]["headers"]
    assert client.get("/v1/parking-records/latest", headers=headers).json()["id"] == saved["id"]
    assert client.get("/v1/dashboard", headers=headers).json()["count"] == 0


def test_dashboard_separates_visibility_from_ongoing_event(client, accounts):
    headers = accounts["alice"]["headers"]
    row = create(
        client,
        accounts,
        "calendar/events",
        {
            "title": "미팅",
            "starts_at": "2026-11-02T10:30:00+09:00",
            "ends_at": "2026-11-02T12:30:00+09:00",
        },
    )

    def items(at, hours=0):
        response = client.get("/v1/dashboard", params={"at": at, "hours": hours}, headers=headers)
        assert response.status_code == 200, response.text
        return [item for group in response.json()["groups"] for item in group["items"]]

    upcoming = items("2026-11-02T09:00:00+09:00")[0]
    assert upcoming["resource_id"] == row["id"]
    assert upcoming["current"] and not upcoming["ongoing"]
    for hours in (0, 3):
        ongoing = items("2026-11-02T11:15:00+09:00", hours)[0]
        assert ongoing["current"] and ongoing["ongoing"]
    assert items("2026-11-02T12:30:00+09:00") == []


def test_library_full_content_search_filters_before_pagination_and_counts(client, accounts, agent):
    headers = accounts["alice"]["headers"]
    marker = "Needle%_"
    long_content = "x" * 240 + marker
    note = create(client, accounts, "notes", {"title": "메모", "body": long_content})
    titled = create(client, accounts, "notes", {"title": marker + " 제목"})
    document = create(
        client,
        accounts,
        "documents",
        {"title": "문서", "filename": marker + "_filename.md", "text": long_content},
    )
    create(client, accounts, "notes", {"title": "검색 대상 아님"})
    deleted = create(client, accounts, "notes", {"title": marker + " 삭제"})
    client.delete(f"/v1/notes/{deleted['id']}", params={"revision": 1}, headers=headers)
    create(client, accounts, "notes", {"title": "타인 메모", "body": marker}, who="bob")
    feature = create(client, accounts, "features", {"title": "정리", "work": "메모 정리"})
    cid = conversation(client, accounts)
    agent.decision = {"action": "reply", "reply": long_content}
    observed = events(
        client.post(
            f"/v1/conversations/{cid}/messages",
            json={"message": "실행", "feature_id": feature["id"]},
            headers={**headers, "Idempotency-Key": str(uuid4())},
        )
    )
    assert observed[-1]["type"] == "run.completed"
    result = next(item for item in observed if item["type"] == "result.saved")
    expected_ids = {note["id"], titled["id"], document["id"], result["result_ref"]["resource_id"]}

    def search(**params):
        response = client.get("/v1/library", params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    first = search(q="  needle%_  ", limit=2)
    assert first["total"] == 4 and first["has_more"] and first["next_offset"] == 2
    second = search(q="needle%_", limit=2, offset=first["next_offset"])
    assert second["total"] == 4 and not second["has_more"] and second["next_offset"] is None
    assert {item["id"] for item in first["items"] + second["items"]} == expected_ids
    assert search(q="needle%_", offset=10)["total"] == 4
    assert search(q="needle%_", kind="document")["total"] == 1
    assert search(q="filename")["items"][0]["id"] == document["id"]
    assert search(q="%_")["total"] == 4
    assert search(q="missing")["total"] == 0
    assert client.get("/v1/library", params={"q": marker}).status_code == 401
    other = client.get(
        "/v1/library", params={"q": marker}, headers=accounts["bob"]["headers"]
    ).json()
    assert other["total"] == 1 and other["items"][0]["id"] not in expected_ids
