from test_poc_organizer_contracts import create


def test_dashboard_shows_five_recent_owned_records_and_library_keeps_the_rest(client, accounts):
    headers = accounts["alice"]["headers"]
    for index in range(7):
        create(client, accounts, "notes", {"title": f"메모 {index}", "body": "본문"})
    deleted = create(
        client,
        accounts,
        "documents",
        {"title": "삭제한 파일", "filename": "deleted.txt", "text": "삭제한 원문"},
    )
    assert (
        client.delete(
            f"/v1/documents/{deleted['id']}", params={"revision": 1}, headers=headers
        ).status_code
        == 200
    )
    create(client, accounts, "notes", {"title": "다른 사용자", "body": "비공개"}, who="bob")

    response = client.get("/v1/dashboard", headers=headers)
    assert response.status_code == 200, response.text
    recent = response.json()["recent_records"]
    all_records = client.get("/v1/library", headers=headers).json()
    assert len(recent) == 5
    assert recent == all_records["items"][:5]
    assert all_records["total"] == 7
    assert [item["title"] for item in recent] == [f"메모 {i}" for i in range(6, 1, -1)]
