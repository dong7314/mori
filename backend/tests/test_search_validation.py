from uuid import uuid4

import pytest


@pytest.mark.parametrize("path", ["/v1/notes", "/v1/library", "/v1/conversations"])
def test_text_search_rejects_nul_and_keeps_literal_unicode_search(client, accounts, path):
    headers = accounts["alice"]["headers"]
    term = "계약 %_\\\n 확인"
    for user in ("alice", "bob"):
        owner_headers = accounts[user]["headers"]
        if path == "/v1/conversations":
            response = client.post(path, json={"title": term}, headers=owner_headers)
        else:
            response = client.post(
                "/v1/notes",
                json={"title": "저장된 메모", "body": term},
                headers={**owner_headers, "Idempotency-Key": str(uuid4())},
            )
        assert response.status_code == 201, response.text
        if user == "alice":
            resource_id = response.json()["id"]
    for value in ("\x00", "before\x00after"):
        invalid = client.get(path, params={"q": value}, headers=headers)
        assert invalid.status_code == 422, invalid.text
    for params in ({"q": term}, {"q": ""}, {}):
        response = client.get(path, params=params, headers=headers)
        assert response.status_code == 200, response.text
        rows = response.json()["items"] if path == "/v1/library" else response.json()
        assert [row["id"] for row in rows] == [resource_id]
