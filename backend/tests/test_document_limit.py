from uuid import uuid4

from mori.organizer.schemas import DOCUMENT_MAX_BYTES


def test_ten_mb_utf8_roundtrip_metadata_listing_and_idempotency(client, accounts):
    headers = {**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())}
    original = " " + "가" * 3_333_332 + "\r\n "
    assert len(original.encode("utf-8")) == DOCUMENT_MAX_BYTES
    payload = {"title": "큰 문서", "filename": "원문.csv", "text": original}
    first = client.post("/v1/documents", headers=headers, json=payload)
    assert first.status_code == 201, first.text[:200]
    rid = first.json()["id"]
    replay = client.post("/v1/documents", headers=headers, json=payload)
    assert replay.status_code == 201 and replay.json()["id"] == rid
    download = client.get(f"/v1/documents/{rid}/download", headers=headers)
    assert download.content == original.encode("utf-8")
    listing = client.get("/v1/documents", headers=headers).json()
    assert len(listing) == 1 and listing[0]["size_bytes"] == DOCUMENT_MAX_BYTES
    assert "text" not in listing[0]
    detail = client.get(f"/v1/documents/{rid}", headers=headers).json()
    assert detail["text"] == original
    library = client.get("/v1/library", headers=headers).json()["items"]
    assert len(library[0]["description"]) == 160
    assert client.get("/v1/documents", headers=accounts["bob"]["headers"]).json() == []
    assert (
        client.get(f"/v1/documents/{rid}/download", headers=accounts["bob"]["headers"]).status_code
        == 404
    )
    too_big = client.post(
        "/v1/documents",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={**payload, "text": original + "x"},
    )
    assert too_big.status_code == 422 and len(too_big.content) < 1000
