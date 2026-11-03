import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from test_chat import conversation
from test_poc_organizer_contracts import create

from mori.chat.context import execution_context
from mori.chat.store import claim
from mori.organizer.models import CalendarEvent, Document, Note, Reminder


def age_record(sessions, model, resource_id, *, days=2):
    old = datetime.now(UTC) - timedelta(days=days)
    with sessions.begin() as session:
        record = session.get(model, UUID(resource_id))
        record.created_at = record.updated_at = old
    return old


def test_note_undo_preserves_saved_date_and_library_order_with_revision_checks(
    client, accounts, sessions
):
    headers = accounts["alice"]["headers"]
    old = create(client, accounts, "notes", {"title": "예전 메모", "body": "원래 내용"})
    saved_at = age_record(sessions, Note, old["id"])
    recent = create(client, accounts, "notes", {"title": "새 메모"})
    path = f"/v1/notes/{old['id']}"

    def ids():
        response = client.get("/v1/library", params={"kind": "note"}, headers=headers)
        assert response.status_code == 200, response.text
        return [row["id"] for row in response.json()["items"]]

    assert ids() == [recent["id"], old["id"]]
    deleted = client.delete(path, params={"revision": 1}, headers=headers)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["revision"] == 2 and deleted.json()["deleted_at"] is not None
    assert datetime.fromisoformat(deleted.json()["updated_at"]) == saved_at
    assert ids() == [recent["id"]]
    assert client.get(path, headers=headers).status_code == 404
    assert client.delete(path, params={"revision": 1}, headers=headers).status_code == 409
    assert client.post(path + "/restore", json={"revision": 1}, headers=headers).status_code == 409
    assert (
        client.post(
            path + "/restore", json={"revision": 2}, headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    restored = client.post(path + "/restore", json={"revision": 2}, headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["revision"] == 3 and restored.json()["deleted_at"] is None
    assert datetime.fromisoformat(restored.json()["updated_at"]) == saved_at
    assert restored.json()["body"] == "원래 내용"
    assert ids() == [recent["id"], old["id"]]
    assert client.post(path + "/restore", json={"revision": 2}, headers=headers).status_code == 409
    assert (
        client.post(path + "/restore", json={"revision": 3}, headers=headers).json()
        == restored.json()
    )
    assert [
        row["id"] for row in client.get("/v1/dashboard", headers=headers).json()["recent_records"]
    ] == [recent["id"], old["id"]]

    edited = client.put(
        path,
        json={"revision": 3, "title": "예전 메모", "body": "새로 저장한 내용"},
        headers=headers,
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["revision"] == 4
    assert datetime.fromisoformat(edited.json()["updated_at"]) > saved_at
    assert ids() == [old["id"], recent["id"]]


def test_restored_old_note_is_excluded_from_today_context_until_content_save(
    client, accounts, sessions
):
    headers = accounts["alice"]["headers"]
    note = create(client, accounts, "notes", {"title": "예전 생각", "body": "예전 내용"})
    age_record(sessions, Note, note["id"])
    path = f"/v1/notes/{note['id']}"
    assert client.delete(path, params={"revision": 1}, headers=headers).status_code == 200
    assert client.post(path + "/restore", json={"revision": 2}, headers=headers).status_code == 200
    feature = create(client, accounts, "features", {"work": "오늘 저장한 메모를 정리해줘"})
    run_id, _, _ = claim(
        sessions,
        accounts["alice"]["user_id"],
        UUID(conversation(client, accounts)),
        uuid4(),
        "지금 실행",
        60,
        UUID(feature["id"]),
    )

    def today_notes():
        context = json.loads(
            execution_context(
                sessions,
                accounts["alice"]["user_id"],
                run_id,
                reference_at=datetime.now(UTC),
            )
        )
        return context["today_notes"]

    assert today_notes() == []
    edited = client.put(
        path, json={"revision": 3, "title": "오늘 고친 생각", "body": "오늘 내용"}, headers=headers
    )
    assert edited.status_code == 200, edited.text
    assert today_notes() == [{"id": note["id"], "title": "오늘 고친 생각", "body": "오늘 내용"}]


@pytest.mark.parametrize(
    "path,model,payload",
    [
        (
            "calendar/events",
            CalendarEvent,
            {
                "title": "약속",
                "starts_at": "2090-01-01T09:00:00Z",
                "ends_at": "2090-01-01T10:00:00Z",
            },
        ),
        ("reminders", Reminder, {"title": "휴식", "target_at": "2090-01-01T09:00:00Z"}),
        ("documents", Document, {"title": "문서", "filename": "문서.md", "text": "원문"}),
    ],
)
def test_other_organizer_records_still_update_lifecycle_timestamp(
    client, accounts, sessions, path, model, payload
):
    headers = accounts["alice"]["headers"]
    record = create(client, accounts, path, payload)
    old = age_record(sessions, model, record["id"])
    url = f"/v1/{path}/{record['id']}"
    deleted = client.delete(url, params={"revision": 1}, headers=headers)
    assert deleted.status_code == 200, deleted.text
    deleted_at = datetime.fromisoformat(deleted.json()["updated_at"])
    assert deleted_at > old
    restored = client.post(url + "/restore", json={"revision": 2}, headers=headers)
    assert restored.status_code == 200, restored.text
    assert datetime.fromisoformat(restored.json()["updated_at"]) > deleted_at
