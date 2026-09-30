import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import func, select
from test_chat import SECRET, Agent, completed, conversation, events, send

from mori.chat.router import get_chat_transport
from mori.dashboard.service import wall_time
from mori.organizer.models import Note, UserPreference
from mori.organizer.schemas import AssistantPreferences, NoteRead, NoteWrite
from mori.organizer.service import create_record, idempotent_create


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


def create(client, accounts, path, payload, *, key=None, who="alice"):
    return client.post(
        "/v1/" + path,
        json=payload,
        headers={**accounts[who]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def event(start="2026-10-01T09:00:00+09:00", end="2026-10-01T10:00:00+09:00"):
    return {"title": "약속", "starts_at": start, "ends_at": end, "timezone": "Asia/Seoul"}


def future():
    return (datetime.now(UTC) + timedelta(hours=1)).isoformat()


@pytest.mark.parametrize(
    "path,payload",
    [
        ("notes", {"title": "생각", "body": "개인 내용"}),
        ("calendar/events", event()),
        ("reminders", {"title": "휴식", "target_at": "2090-10-01T09:00:00+09:00"}),
        ("documents", {"title": "문서", "filename": "회의.txt", "text": "첫 줄\n둘째 줄"}),
        ("features", {"title": "정리", "work": "오늘 메모 정리"}),
    ],
)
def test_owned_creates_idempotency_and_conflict(client, accounts, path, payload):
    key = uuid4()
    first = create(client, accounts, path, payload, key=key)
    assert first.status_code == 201, first.text
    assert create(client, accounts, path, payload, key=key).json() == first.json()
    assert (
        create(client, accounts, path, {**payload, "title": "다른 요청"}, key=key).status_code
        == 409
    )
    rid = first.json()["id"]
    assert client.get(f"/v1/{path}/{rid}", headers=accounts["bob"]["headers"]).status_code == 404
    assert client.get(f"/v1/{path}/{rid}").status_code == 401
    assert "user_id" not in first.json()
    assert (
        create(
            client, accounts, path, {**payload, "user_id": str(accounts["bob"]["user_id"])}
        ).status_code
        == 422
    )
    other = create(client, accounts, path, payload, key=key, who="bob")
    assert other.status_code == 201 and other.json()["id"] != rid


@pytest.mark.parametrize(
    "path,payload",
    [
        ("notes", {"title": "생각"}),
        ("calendar/events", event()),
        ("reminders", {"title": "휴식", "target_at": "2090-10-01T09:00:00+09:00"}),
    ],
)
def test_revision_and_delete_restore(client, accounts, path, payload):
    h = accounts["alice"]["headers"]
    row = create(client, accounts, path, payload).json()
    url = f"/v1/{path}/{row['id']}"
    body = {**payload, "revision": 1, "title": "바꾼 제목"}
    assert client.put(url, json=body, headers=h).json()["revision"] == 2
    assert client.put(url, json=body, headers=h).status_code == 409
    assert client.delete(url, params={"revision": 1}, headers=h).status_code == 409
    assert client.delete(url, params={"revision": 2}, headers=h).json()["revision"] == 3
    assert client.get(url, headers=h).status_code == 404
    assert (
        client.post(
            url + "/restore", json={"revision": 3}, headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    restored = client.post(url + "/restore", json={"revision": 3}, headers=h)
    assert restored.json()["deleted_at"] is None and restored.json()["revision"] == 4
    assert client.get(url, headers=h).json()["title"] == "바꾼 제목"


def test_search_literal_pagination_library(client, accounts):
    h = accounts["alice"]["headers"]
    for title in ("100% 완료", "메모 둘", "메모 셋"):
        create(client, accounts, "notes", {"title": title})
    assert len(client.get("/v1/notes", params={"q": "%"}, headers=h).json()) == 1
    first = client.get("/v1/library", params={"limit": 2}, headers=h).json()
    assert len(first["items"]) == 2 and first["next_offset"] == 2
    second = client.get("/v1/library", params={"offset": 2}, headers=h).json()
    assert len(second["items"]) == 1 and not second["has_more"]
    assert client.get("/v1/library", headers=accounts["bob"]["headers"]).json()["items"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"revision": 0, "timezone": "Asia/Imaginary"},
        {"revision": 0, "commute_time": "25:00"},
        {"revision": 0, "commute_days": [0, 0]},
        {"revision": 0, "commute_days": [-1]},
        {"revision": 0, "parking_lead_minutes": 181},
    ],
)
def test_invalid_assistant_context(payload):
    with pytest.raises(ValidationError):
        AssistantPreferences.model_validate(payload)


def test_calendar_overlap_not_just_start_day_and_exclusive_end(client, accounts):
    h = accounts["alice"]["headers"]
    spanning = create(
        client,
        accounts,
        "calendar/events",
        event("2026-09-30T23:30:00+09:00", "2026-10-01T00:30:00+09:00"),
    ).json()
    create(
        client,
        accounts,
        "calendar/events",
        event("2026-09-30T23:00:00+09:00", "2026-10-01T00:00:00+09:00"),
    )
    create(
        client,
        accounts,
        "calendar/events",
        event("2026-10-02T00:00:00+09:00", "2026-10-02T01:00:00+09:00"),
    )
    query = {"from": "2026-10-01T00:00:00+09:00", "until": "2026-10-02T00:00:00+09:00"}
    rows = client.get("/v1/calendar/events", params=query, headers=h).json()
    assert [r["id"] for r in rows] == [spanning["id"]]
    assert (
        client.get(
            "/v1/calendar/events", params={**query, "until": query["from"]}, headers=h
        ).status_code
        == 422
    )
    assert (
        create(
            client, accounts, "calendar/events", event("2026-10-01T09:00:00", "2026-10-01T10:00:00")
        ).status_code
        == 422
    )
    assert (
        create(client, accounts, "calendar/events", {**event(), "all_day": True}).status_code == 422
    )
    assert (
        create(
            client,
            accounts,
            "calendar/events",
            {**event("2026-10-01T00:00:00+09:00", "2026-10-02T00:00:00+09:00"), "all_day": True},
        ).status_code
        == 201
    )


def test_reminder_extend_cancel_and_delivery_status(client, accounts):
    h = accounts["alice"]["headers"]
    payload = {"title": "잠깐 쉬기", "target_at": future()}
    row = create(client, accounts, "reminders", payload).json()
    assert row["delivery_status"] == "not_configured"
    url = "/v1/reminders/" + row["id"]
    target = (datetime.fromisoformat(row["target_at"]) + timedelta(minutes=5)).isoformat()
    extended = client.put(
        url, json={**payload, "target_at": target, "revision": 1}, headers=h
    ).json()
    assert datetime.fromisoformat(extended["target_at"]) == datetime.fromisoformat(target)
    cancelled = client.post(url + "/cancel", json={"revision": 2}, headers=h).json()
    assert cancelled["cancelled"] and cancelled["delivery_status"] == "not_configured"
    assert (
        create(
            client, accounts, "reminders", {**payload, "target_at": "2000-01-01T00:00:00Z"}
        ).status_code
        == 422
    )


def test_document_original_download_no_fake_summary_and_size(client, accounts):
    h = accounts["alice"]["headers"]
    payload = {"title": "내 메모", "filename": "회의 메모.txt", "text": "원문 그대로\n둘째 줄"}
    row = create(client, accounts, "documents", payload).json()
    assert row["processing"] == "stored_original"
    response = client.get(f"/v1/documents/{row['id']}/download", headers=h)
    assert response.text == payload["text"]
    assert response.headers["content-disposition"].startswith("attachment; filename*=UTF-8''")
    assert (
        client.get(
            f"/v1/documents/{row['id']}/download", headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    assert (
        create(client, accounts, "documents", {**payload, "text": "가" * 66667}).status_code == 422
    )
    for filename in ("../secret.txt", "test.docx", "test\r\nheader.txt"):
        assert (
            create(client, accounts, "documents", {**payload, "filename": filename}).status_code
            == 422
        )


def test_feature_draft_versions_pause_and_schedule_contract(client, accounts):
    h = accounts["alice"]["headers"]
    row = create(client, accounts, "features", {}).json()
    assert row["status"] == "draft"
    url = "/v1/features/" + row["id"]
    assert (
        client.post(url + "/state", json={"revision": 1, "status": "active"}, headers=h).status_code
        == 409
    )
    updated = client.put(
        url,
        json={
            "revision": 1,
            "work": "오늘 메모 정리",
            "schedule": {"time": "19:00", "repeat": "weekdays"},
        },
        headers=h,
    ).json()
    assert updated["version"] == 2 and updated["status"] == "active"
    assert updated["automation_status"] == "not_configured"
    assert client.get(url + "/versions/1", headers=h).json()["work"] == ""
    assert client.get(url + "/versions/1", headers=accounts["bob"]["headers"]).status_code == 404
    assert (
        client.post(url + "/state", json={"revision": 2, "status": "paused"}, headers=h).json()[
            "status"
        ]
        == "paused"
    )
    assert (
        create(
            client, accounts, "features", {"schedule": {"time": "09:00", "repeat": "once"}}
        ).status_code
        == 422
    )
    assert (
        create(
            client,
            accounts,
            "features",
            {"schedule": {"time": "09:00", "repeat": "daily", "date": "2026-10-01"}},
        ).status_code
        == 422
    )
    assert (
        create(
            client, accounts, "features", {"builtin_key": "news", "work": "뉴스 검색"}
        ).status_code
        == 201
    )
    assert (
        create(
            client, accounts, "features", {"builtin_key": "news", "work": "뉴스 검색"}
        ).status_code
        == 409
    )


def cards(response):
    assert response.status_code == 200, response.text
    return [item for group in response.json()["groups"] for item in group["items"]]


def test_dashboard_windows_boundary_and_read_only(client, accounts):
    h = accounts["alice"]["headers"]
    create(
        client,
        accounts,
        "calendar/events",
        event("2026-09-30T23:30:00+09:00", "2026-10-01T00:30:00+09:00"),
    )
    exact_end = create(
        client,
        accounts,
        "calendar/events",
        event("2026-10-01T03:00:00+09:00", "2026-10-01T04:00:00+09:00"),
    ).json()
    create(
        client,
        accounts,
        "features",
        {
            "title": "퇴근 정리",
            "work": "메모 정리",
            "schedule": {"time": "01:00", "repeat": "daily"},
        },
    )
    before = client.get("/v1/features", headers=h).json()
    params = {"at": "2026-10-01T00:00:00+09:00", "hours": 3}
    rows = cards(client.get("/v1/dashboard", params=params, headers=h))
    assert len(rows) == 2 and all(r["resource_id"] != exact_end["id"] for r in rows)
    assert rows[0]["current"] and rows[1]["availability"] == "automation_not_configured"
    for hours in (0, 3, 5, 24):
        cards(client.get("/v1/dashboard", params={**params, "hours": hours}, headers=h))
    assert client.get("/v1/features", headers=h).json() == before
    assert (
        client.get("/v1/library", params={"kind": "feature_result"}, headers=h).json()["items"]
        == []
    )
    assert (
        cards(client.get("/v1/dashboard", params=params, headers=accounts["bob"]["headers"])) == []
    )
    assert client.get("/v1/dashboard", params={**params, "hours": 2}, headers=h).status_code == 422


def test_parking_display_uses_existing_assistant_context(client, accounts, sessions):
    h = accounts["alice"]["headers"]
    create(client, accounts, "parking-records", {"floor": "B3", "spot": "B16"})
    query = {"at": "2026-10-01T08:40:00+09:00"}
    assert cards(client.get("/v1/dashboard", params=query, headers=h)) == []
    with sessions.begin() as session:
        session.add(
            UserPreference(
                user_id=accounts["alice"]["user_id"], data={"commute_time": "09:00"}, revision=1
            )
        )
    rows = cards(client.get("/v1/dashboard", params=query, headers=h))
    assert len(rows) == 1 and rows[0]["description"] == "B3 B16"
    assert (
        cards(client.get("/v1/dashboard", params={"at": "2026-10-03T08:40:00+09:00"}, headers=h))
        == []
    )
    with sessions.begin() as session:
        row = session.get(UserPreference, accounts["alice"]["user_id"])
        row.data = {"commute_time": "00:15", "commute_days": [4]}
    rows = cards(client.get("/v1/dashboard", params={"at": "2026-10-01T23:50:00+09:00"}, headers=h))
    assert len(rows) == 1  # Friday's commute is already displayed on Thursday.


def test_dst_nonexistent_is_skipped_and_fold_uses_first_occurrence():
    zone = ZoneInfo("America/New_York")
    assert wall_time(date(2026, 3, 8), "02:30", zone) is None
    assert wall_time(date(2026, 11, 1), "01:30", zone) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


def test_conversation_rename_pin_search_delete_and_pagination(client, accounts, agent):
    h = accounts["alice"]["headers"]
    one, two = conversation(client, accounts), conversation(client, accounts)
    send(client, accounts, one, message="unique parking query")
    updated = client.patch(
        "/v1/conversations/" + one,
        json={"revision": 1, "title": "출근 기록", "pinned": True},
        headers=h,
    )
    assert updated.status_code == 200
    assert client.get("/v1/conversations", headers=h).json()[0]["id"] == one
    assert len(client.get("/v1/conversations", params={"q": "unique"}, headers=h).json()) == 1
    assert (
        client.get("/v1/conversations", params={"limit": 1, "offset": 1}, headers=h).json()[0]["id"]
        == two
    )
    assert (
        client.patch(
            "/v1/conversations/" + one, json={"revision": 1, "pinned": False}, headers=h
        ).status_code
        == 409
    )
    assert (
        client.delete("/v1/conversations/" + one, params={"revision": 2}, headers=h).status_code
        == 204
    )
    assert client.get("/v1/conversations/" + one + "/messages", headers=h).status_code == 404
    assert send(client, accounts, one).status_code == 404


@pytest.mark.parametrize(
    "action,payload_field,payload,path",
    [
        ("note_save", "note", {"title": "채팅 메모", "body": "우산"}, "notes"),
        ("event_save", "event", event(), "calendar/events"),
        (
            "reminder_save",
            "reminder",
            {"title": "물", "target_at": "2090-01-01T00:00:00Z"},
            "reminders",
        ),
        ("feature_save", "feature", {"title": "퇴근", "work": "메모 정리"}, "features"),
    ],
)
def test_chat_and_direct_screens_share_domain_and_replay(
    client, accounts, agent, action, payload_field, payload, path
):
    agent.decision = {"action": action, payload_field: payload}
    cid, key = conversation(client, accounts), uuid4()
    response = send(client, accounts, cid, message="저장해줘", key=key)
    observed = events(response)
    assert observed[-1]["type"] == "run.completed", observed
    saved = next(e for e in observed if e["type"] == "action.completed")["result"]
    ref = next(e for e in observed if e["type"] == "action.completed")["result_ref"]
    assert ref["resource_id"] == saved["id"]
    assert ref["detail_url"] == f"/v1/{path}/{saved['id']}"
    history = client.get(
        f"/v1/conversations/{cid}/messages", headers=accounts["alice"]["headers"]
    ).json()
    assert history[0]["result_refs"] == [ref]
    assert (
        client.get(f"/v1/{path}/{saved['id']}", headers=accounts["alice"]["headers"]).status_code
        == 200
    )
    assert events(send(client, accounts, cid, message="저장해줘", key=key)) == observed
    assert len(agent.requests) == 2


def test_feature_execution_snapshots_result_context_and_replay(client, accounts, agent):
    h = accounts["alice"]["headers"]
    create(client, accounts, "notes", {"title": "내 할 일", "body": "우산 챙기기"})
    create(client, accounts, "notes", {"title": "BOB_SECRET"}, who="bob")
    feature = create(
        client, accounts, "features", {"title": "퇴근 정리", "work": "오늘 메모 정리"}
    ).json()
    cid, key = conversation(client, accounts), str(uuid4())
    agent.decision = {"action": "reply", "reply": "우산 챙기기"}
    body = {"message": "실행해줘", "feature_id": feature["id"]}
    headers = {**h, "Idempotency-Key": key}
    response = client.post(f"/v1/conversations/{cid}/messages", json=body, headers=headers)
    observed = events(response)
    assert observed[-1]["type"] == "run.completed"
    result = next(e for e in observed if e["type"] == "result.saved")
    stored = client.get(result["detail_url"], headers=h).json()
    history = client.get(f"/v1/conversations/{cid}/messages", headers=h).json()
    assert history[0]["result_refs"] == [result["result_ref"]]
    assert result["result_ref"]["resource_id"] == stored["id"]
    assert stored["feature_version"] == 1 and stored["text"] == "우산 챙기기"
    assert "BOB_SECRET" not in json.loads(agent.requests[-1].content)["instructions"]
    assert "우산 챙기기" in json.loads(agent.requests[-1].content)["instructions"]
    assert client.get(result["detail_url"], headers=accounts["bob"]["headers"]).status_code == 404
    client.put(
        "/v1/features/" + feature["id"], json={"revision": 1, "work": "다른 작업"}, headers=h
    )
    assert client.get(result["detail_url"], headers=h).json()["feature_version"] == 1
    assert (
        events(client.post(f"/v1/conversations/{cid}/messages", json=body, headers=headers))
        == observed
    )
    assert len(agent.requests) == 2
    assert (
        client.post(
            f"/v1/conversations/{cid}/messages", json={"message": "실행해줘"}, headers=headers
        ).status_code
        == 409
    )
    assert (
        client.get("/v1/library", params={"kind": "feature_result"}, headers=h).json()["items"][0][
            "id"
        ]
        == stored["id"]
    )


def test_automatic_feature_selection_and_original_request_replay(client, accounts, agent):
    feature = create(
        client, accounts, "features", {"title": "퇴근 정리", "work": "오늘 메모 정리"}
    ).json()
    calls = []

    def auto(request):
        if request.url.path == "/v1/toolsets":
            return agent(request)
        calls.append(request)
        # The instruction text mentions the field even before binding; inspect the actual JSON.
        context = json.loads(
            json.loads(request.content)["instructions"].split("Mori 사용자 문맥(JSON 데이터):\n")[1]
        )
        selected = "selected_feature" in context
        decision = (
            {"action": "reply", "reply": "정리한 결과"}
            if selected
            else {"action": "feature_run", "feature_id": feature["id"]}
        )
        return httpx.Response(
            200,
            text="data: " + json.dumps(completed(decision)) + "\n\n",
            headers={"Content-Type": "text/event-stream"},
        )

    client.app.dependency_overrides[get_chat_transport] = lambda: httpx.MockTransport(auto)
    cid, key = conversation(client, accounts), uuid4()
    observed = events(send(client, accounts, cid, message="퇴근 정리해줘", key=key))
    assert any(e["type"] == "feature.selected" for e in observed), observed
    assert any(e["type"] == "result.saved" for e in observed), observed
    assert events(send(client, accounts, cid, message="퇴근 정리해줘", key=key)) == observed
    assert len(calls) == 2


def test_feature_cannot_execute_another_users_or_paused_or_stock(client, accounts, agent):
    h = accounts["alice"]["headers"]
    other = create(client, accounts, "features", {"work": "메모 정리"}, who="bob").json()
    own = create(client, accounts, "features", {"work": "메모 정리"}).json()
    stock = create(
        client, accounts, "features", {"work": "주가 조회", "builtin_key": "stock"}
    ).json()
    client.post(
        "/v1/features/" + own["id"] + "/state", json={"revision": 1, "status": "paused"}, headers=h
    )
    cid = conversation(client, accounts)
    for feature, status in ((other, 404), (own, 409), (stock, 503)):
        response = client.post(
            f"/v1/conversations/{cid}/messages",
            json={"message": "실행", "feature_id": feature["id"]},
            headers={**h, "Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == status, response.text
    assert not agent.requests


def test_concurrent_creates_one_effect_and_immutable_receipt(sessions, accounts):
    uid, key = accounts["alice"]["user_id"], uuid4()
    payload = NoteWrite(title="한 번만")

    def attempt():
        with sessions() as session:
            return idempotent_create(
                session,
                uid,
                "notes",
                key,
                payload,
                lambda: create_record(session, Note, uid, payload),
                NoteRead.model_validate,
            )

    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: attempt(), range(4)))
    assert all(r == responses[0] for r in responses)
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Note)) == 1


def test_new_cors_methods(client):
    for method in ("PUT", "PATCH", "DELETE"):
        response = client.options(
            "/v1/notes",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": method},
        )
        assert response.status_code == 200


def test_receipt_replay_after_edit_does_not_restore_old_state(client, accounts):
    h = accounts["alice"]["headers"]
    key = uuid4()
    original = create(client, accounts, "notes", {"title": "원본"}, key=key).json()
    url = "/v1/notes/" + original["id"]
    client.put(url, json={"revision": 1, "title": "수정본"}, headers=h)
    assert create(client, accounts, "notes", {"title": "원본"}, key=key).json() == original
    assert client.get(url, headers=h).json()["title"] == "수정본"


def test_auto_feature_selection_rejects_foreign_id(client, accounts, agent):
    other = create(client, accounts, "features", {"work": "비공개"}, who="bob").json()
    agent.decision = {"action": "feature_run", "feature_id": other["id"]}
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.failed"
    assert observed[-1]["code"] == "RESOURCE_NOT_FOUND"
    assert not any(e["type"] == "result.saved" for e in observed)


def test_selected_feature_cannot_write_domain_records(client, accounts, agent):
    h = accounts["alice"]["headers"]
    feature = create(client, accounts, "features", {"work": "정리해줘"}).json()
    agent.decision = {"action": "note_save", "note": {"title": "허용 안 된 저장"}}
    cid = conversation(client, accounts)
    response = client.post(
        f"/v1/conversations/{cid}/messages",
        json={"message": "실행", "feature_id": feature["id"]},
        headers={**h, "Idempotency-Key": str(uuid4())},
    )
    observed = events(response)
    assert observed[-1]["type"] == "run.failed"
    assert observed[-1]["code"] == "FEATURE_ACTION_NOT_ALLOWED"
    assert client.get("/v1/notes", headers=h).json() == []
    assert client.get("/v1/features/" + feature["id"] + "/results", headers=h).json() == []


def test_invalid_agent_payload_has_no_partial_save(client, accounts, agent):
    agent.decision = {"action": "note_save", "note": {"title": "메모"}, "event": event()}
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.failed"
    assert observed[-1]["code"] == "INVALID_AGENT_RESPONSE"
    assert client.get("/v1/notes", headers=accounts["alice"]["headers"]).json() == []


def test_dashboard_one_off_pause_truncation_and_future_not_completed(client, accounts):
    h = accounts["alice"]["headers"]
    payload = {
        "work": "정리",
        "schedule": {"time": "23:30", "repeat": "once", "date": "2026-09-30"},
    }
    feature = create(client, accounts, "features", payload).json()
    create(
        client,
        accounts,
        "calendar/events",
        event("2026-09-30T23:45:00+09:00", "2026-10-01T00:30:00+09:00"),
    )
    params = {"at": "2026-09-30T22:00:00+09:00", "hours": 24, "limit": 1}
    result = client.get("/v1/dashboard", params=params, headers=h)
    assert result.status_code == 200 and result.json()["truncated"]
    rows = cards(client.get("/v1/dashboard", params={**params, "limit": 100}, headers=h))
    selected = [r for r in rows if r["kind"] == "feature"]
    assert len(selected) == 1 and not selected[0]["current"]
    assert selected[0]["availability"] == "automation_not_configured"
    client.post(
        "/v1/features/" + feature["id"] + "/state",
        json={"revision": 1, "status": "paused"},
        headers=h,
    )
    rows = cards(client.get("/v1/dashboard", params={**params, "limit": 100}, headers=h))
    assert all(r["kind"] != "feature" for r in rows)
    assert (
        client.get("/v1/dashboard", params={"at": "0001-01-01T00:00:00Z"}, headers=h).status_code
        == 422
    )


def test_document_keeps_leading_and_trailing_whitespace(client, accounts):
    text = "  문단\n\n끝\n"
    saved = create(
        client, accounts, "documents", {"title": "원문", "filename": "text.md", "text": text}
    ).json()
    assert saved["text"] == text
    assert (
        client.get(
            f"/v1/documents/{saved['id']}/download", headers=accounts["alice"]["headers"]
        ).text
        == text
    )
