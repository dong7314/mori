import asyncio
import io
from uuid import uuid4

import pytest
from docx import Document

from mori.artifacts.service import run_document_once


def merged_document(direction):
    document = Document()
    document.add_paragraph("before")
    table = document.add_table(rows=3, cols=3)
    table.cell(0, 0).text = "unique merged amount 123-456"
    last = {"horizontal": (0, 1), "vertical": (1, 0), "rectangle": (1, 1)}[direction]
    merged = table.cell(0, 0).merge(table.cell(*last))
    if direction == "rectangle":
        merged.paragraphs[0].add_run("x" * 12000)
    merged.add_table(rows=1, cols=1).cell(0, 0).text = "nested merged content"
    table.cell(0, 2).text = "row 0"
    table.cell(1, 2).text = "row 1"
    table.cell(2, 0).text = "same independent value"
    table.cell(2, 1).text = "same independent value"
    table.cell(2, 2).text = "row 2"
    document.add_paragraph("after")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


@pytest.mark.parametrize("direction", ["horizontal", "vertical", "rectangle"])
def test_merged_docx_cells_read_and_convert_once(client, accounts, sessions, direction):
    settings = client.app.state.settings
    settings.documents_enabled = True
    headers = accounts["alice"]["headers"]
    original = merged_document(direction)
    response = client.post(
        "/v1/files",
        params={"filename": "merged.docx"},
        content=original,
        headers={**headers, "Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    file_id = response.json()["id"]
    for operation in ("read", "convert"):
        payload = {"operation": operation, "source_file_id": file_id}
        if operation == "convert":
            payload["format"] = "txt"
        response = client.post(
            "/v1/document-jobs",
            json=payload,
            headers={**headers, "Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 202, response.text
        assert asyncio.run(run_document_once(sessions, settings))
        result = client.get("/v1/document-jobs/" + response.json()["id"], headers=headers).json()
        assert result["status"] == "completed", result
        if operation == "read":
            value = result["result"]["data"]["text"]
            assert result["result"]["data"]["truncated"] is False
            assert result["result"]["data"]["body_paragraphs"] == [
                {"index": 0, "text": "before"},
                {"index": 1, "text": "after"},
            ]
        else:
            value = client.get(
                "/v1/files/" + result["output_file_id"] + "/content", headers=headers
            ).text
            assert result["result"]["data"]["source_truncated"] is False
        assert value.count("unique merged amount 123-456") == 1, value[:300]
        assert value.count("same independent value") == 2, value[:300]
        assert value.count("nested merged content") == 1, value[:300]
        assert value.index("before") < value.index("row 0") < value.index("row 1")
        assert value.index("row 1") < value.index("row 2") < value.index("after")
    assert client.get("/v1/files/" + file_id + "/content", headers=headers).content == original
