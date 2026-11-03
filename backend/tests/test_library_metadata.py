from datetime import UTC, datetime
from uuid import UUID

from test_artifacts import upload
from test_chat import agent as agent
from test_feature_contracts import execute_feature
from test_poc_organizer_contracts import create

from mori.features.models import FeatureResult


def library(client, accounts, **params):
    response = client.get("/v1/library", params=params, headers=accounts["alice"]["headers"])
    assert response.status_code == 200, response.text
    return response.json()


def test_library_document_rows_have_filename_and_utf8_size_without_originals(client, accounts):
    headers = accounts["alice"]["headers"]
    source = "한글 원문\n" * 80 + "검색용 끝부분"
    document = create(
        client,
        accounts,
        "documents",
        {"title": "회의 자료", "filename": "회의 자료.md", "text": source},
    )
    uploaded = upload(client, accounts, "첨부 원문.txt", source.encode())
    assert uploaded.status_code == 201, uploaded.text
    file = uploaded.json()
    create(client, accounts, "notes", {"title": "메모", "body": source})
    create(
        client,
        accounts,
        "documents",
        {"title": "다른 사람의 문서", "filename": "비공개.md", "text": source},
        who="bob",
    )

    response = library(client, accounts, kind="document", limit=1)
    assert response["total"] == 2 and response["has_more"]
    rows = response["items"] + library(client, accounts, kind="document", offset=1)["items"]
    assert {row["id"] for row in rows} == {document["id"], file["id"]}
    for row in rows:
        expected_name = "회의 자료.md" if row["id"] == document["id"] else "첨부 원문.txt"
        assert row["filename"] == expected_name and row["icon"] == "file"
        assert row["size_bytes"] == len(source.encode("utf-8"))
        assert row["item_count"] is None and row["completed_count"] is None
        assert "text" not in row and "content" not in row
        assert len(row["description"]) <= 160
    found = library(client, accounts, kind="document", q="검색용 끝부분")
    assert [row["id"] for row in found["items"]] == [document["id"]]
    note = library(client, accounts, kind="note")["items"][0]
    assert note["icon"] == "note" and note["filename"] is None and note["size_bytes"] is None
    assert note["item_count"] is None and note["completed_count"] is None

    dashboard = client.get("/v1/dashboard", headers=headers).json()
    assert dashboard["recent_records"] == library(client, accounts)["items"]

    doc_path, file_path = f"/v1/documents/{document['id']}", f"/v1/files/{file['id']}"
    assert client.delete(doc_path, params={"revision": 1}, headers=headers).status_code == 200
    assert client.delete(file_path, headers=headers).status_code == 200
    assert library(client, accounts, kind="document")["total"] == 0
    assert (
        client.post(doc_path + "/restore", json={"revision": 2}, headers=headers).status_code == 200
    )
    assert client.post(file_path + "/restore", headers=headers).status_code == 200
    restored = library(client, accounts, kind="document")
    assert restored["total"] == 2
    assert all(row["size_bytes"] == len(source.encode("utf-8")) for row in restored["items"])


def test_library_result_rows_follow_checklist_and_current_feature_icon(client, accounts, agent):
    headers = accounts["alice"]["headers"]
    url, _, feature = execute_feature(
        client, accounts, agent, text="오늘의 할 일\n- [ ] 우산 챙기기\n- [x] 문 잠그기"
    )
    result = client.get(url, headers=headers).json()
    response = client.put(
        f"/v1/features/{feature['id']}",
        json={"revision": 1, "title": "하루 마무리", "work": "메모를 정리해줘", "icon": "moon"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    row = library(client, accounts, kind="feature_result")["items"][0]
    assert row["id"] == result["id"] and row["detail_url"] == url
    assert row["icon"] == "moon" and row["item_count"] == 2 and row["completed_count"] == 1
    assert row["filename"] is None and row["size_bytes"] is None
    assert "items" not in row and "text" not in row
    changed = client.patch(
        url + "/items/" + result["items"][0]["id"],
        json={"revision": 1, "done": True},
        headers=headers,
    )
    assert changed.status_code == 200, changed.text
    updated = library(client, accounts, kind="feature_result")["items"][0]
    assert updated["item_count"] == updated["completed_count"] == 2
    assert client.get("/v1/dashboard", headers=headers).json()["recent_records"] == [updated]
    assert client.get("/v1/library", headers=accounts["bob"]["headers"]).json()["items"] == []


def test_library_text_only_result_reports_zero_tasks_and_excludes_deleted(
    client, accounts, agent, sessions
):
    url, _, _ = execute_feature(client, accounts, agent, text="목록이 없는 결과입니다.")
    row = library(client, accounts, kind="feature_result")["items"][0]
    assert row["item_count"] == row["completed_count"] == 0
    assert row["icon"] == "spark"
    with sessions.begin() as session:
        session.get(FeatureResult, UUID(row["id"])).deleted_at = datetime.now(UTC)
    assert library(client, accounts, kind="feature_result")["total"] == 0
    assert client.get(url, headers=accounts["alice"]["headers"]).status_code == 404
