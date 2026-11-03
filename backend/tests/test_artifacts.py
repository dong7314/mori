import asyncio
import io
import zipfile
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from docx import Document
from sqlalchemy import select

from mori.artifacts.models import DocumentJob, StoredFile
from mori.artifacts.service import run_document_once


def upload(client, accounts, filename, body, key=None, user="alice"):
    client.app.state.settings.documents_enabled = True
    return client.post(
        "/v1/files",
        params={"filename": filename},
        content=body,
        headers={
            **accounts[user]["headers"],
            "Content-Type": "application/octet-stream",
            "Idempotency-Key": str(key or uuid4()),
        },
    )


def submit(client, accounts, payload, key=None):
    client.app.state.settings.documents_enabled = True
    return client.post(
        "/v1/document-jobs",
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def test_files_owner_idempotency_quota_and_trash(client, accounts):
    key = uuid4()
    r = upload(client, accounts, "기록.txt", "주차 B16".encode(), key)
    assert r.status_code == 201, r.text
    file = r.json()
    h = accounts["alice"]["headers"]
    path = "/v1/files/" + file["id"]
    assert upload(client, accounts, "기록.txt", "주차 B16".encode(), key).json()["id"] == file["id"]
    assert upload(client, accounts, "기록.txt", b"different", key).status_code == 409
    assert client.get(path + "/content", headers=accounts["bob"]["headers"]).status_code == 404
    assert client.get(path + "/content", headers=h).content == "주차 B16".encode()
    assert "content" not in client.get("/v1/files", headers=h).json()[0]
    client.delete(path, headers=h)
    assert client.get(path + "/content", headers=h).status_code == 404
    assert client.post(path + "/restore", headers=h).status_code == 200
    settings = client.app.state.settings
    settings.document_user_quota_bytes = 10
    assert upload(client, accounts, "more.txt", b"abcdefghij").status_code == 409


def test_real_docx_create_edit_and_read_survive_worker_restart(client, accounts, sessions):
    response = submit(
        client,
        accounts,
        {
            "operation": "create",
            "format": "docx",
            "spec": {"title": "모리 문서", "paragraphs": ["원본 문장"]},
        },
    )
    assert response.status_code == 202, response.text
    job = response.json()
    h = accounts["alice"]["headers"]
    settings = client.app.state.settings
    assert asyncio.run(run_document_once(sessions, settings))
    done = client.get("/v1/document-jobs/" + job["id"], headers=h).json()
    assert done["status"] == "completed", done
    original = done["output_file_id"]
    body = client.get("/v1/files/" + original + "/content", headers=h).content
    assert Document(io.BytesIO(body)).paragraphs[1].text == "원본 문장"
    edit = submit(
        client,
        accounts,
        {
            "operation": "edit",
            "source_file_id": original,
            "spec": {"paragraph_updates": [{"index": 1, "text": "수정 문장"}]},
        },
    ).json()
    assert asyncio.run(run_document_once(sessions, settings))
    edited = client.get("/v1/document-jobs/" + edit["id"], headers=h).json()
    assert edited["status"] == "completed", edited
    read = submit(
        client, accounts, {"operation": "read", "source_file_id": edited["output_file_id"]}
    ).json()
    assert asyncio.run(run_document_once(sessions, settings))
    preview = client.get("/v1/document-jobs/" + read["id"], headers=h).json()
    assert "수정 문장" in preview["result"]["data"]["text"]
    assert client.get("/v1/files/" + original + "/content", headers=h).content == body
    assert (
        client.get(
            "/v1/document-jobs/" + read["id"], headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )


def test_docx_read_and_convert_preserve_paragraph_table_order(client, accounts, sessions):
    document = Document()
    document.add_paragraph("첫 번째 항목")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "첫 번째 표"
    table.cell(0, 1).text = "내용"
    document.add_paragraph("두 번째 항목")
    document.add_table(rows=1, cols=1).cell(0, 0).text = "두 번째 표"
    document.add_paragraph("마지막 문단")
    data = io.BytesIO()
    document.save(data)
    source = upload(client, accounts, "ordered.docx", data.getvalue()).json()
    expected = "첫 번째 항목\n첫 번째 표\t내용\n두 번째 항목\n두 번째 표\n마지막 문단"
    headers = accounts["alice"]["headers"]
    for operation in ("read", "convert"):
        payload = {"operation": operation, "source_file_id": source["id"]}
        if operation == "convert":
            payload["format"] = "txt"
        job = submit(client, accounts, payload).json()
        assert asyncio.run(run_document_once(sessions, client.app.state.settings))
        result = client.get("/v1/document-jobs/" + job["id"], headers=headers).json()
        assert result["status"] == "completed", result
        if operation == "read":
            assert result["result"]["data"]["text"] == expected
            assert result["result"]["data"]["body_paragraphs"] == [
                {"index": 0, "text": "첫 번째 항목"},
                {"index": 1, "text": "두 번째 항목"},
                {"index": 2, "text": "마지막 문단"},
            ]
        else:
            output = client.get(
                "/v1/files/" + result["output_file_id"] + "/content", headers=headers
            )
            assert output.text == expected


def test_job_rejects_foreign_source_deleted_input_and_oversize(client, accounts, sessions):
    file = upload(client, accounts, "secret.txt", b"private", user="bob").json()
    assert (
        submit(client, accounts, {"operation": "read", "source_file_id": file["id"]}).status_code
        == 404
    )
    file = upload(client, accounts, "mine.txt", b"hello").json()
    job = submit(client, accounts, {"operation": "read", "source_file_id": file["id"]}).json()
    client.delete("/v1/files/" + file["id"], headers=accounts["alice"]["headers"])
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    failed = client.get(
        "/v1/document-jobs/" + job["id"], headers=accounts["alice"]["headers"]
    ).json()
    assert failed["status"] == "failed" and failed["error_code"] == "FILE_NOT_FOUND"
    client.app.state.settings.document_max_bytes = 5
    assert upload(client, accounts, "large.txt", b"123456").status_code == 413
    assert upload(client, accounts, "../a.txt", b"x").status_code == 422


def test_expired_document_lease_recovers_once(client, accounts, sessions):
    job = submit(
        client, accounts, {"operation": "create", "format": "txt", "spec": {"text": "recovered"}}
    ).json()
    with sessions.begin() as s:
        row = s.get(DocumentJob, job["id"])
        row.status = "running"
        row.attempts = 1
        row.lease_token = uuid4()
        row.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    assert asyncio.run(run_document_once(sessions, client.app.state.settings))
    assert not asyncio.run(run_document_once(sessions, client.app.state.settings))
    with sessions() as s:
        row = s.get(DocumentJob, job["id"])
        assert row.status == "completed" and row.attempts == 2
        assert len(list(s.scalars(select(StoredFile)))) == 1


def test_hwpx_text_conversion_and_macro_rejection(client, accounts, sessions):
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as z:
        z.writestr(
            "Contents/section0.xml",
            '<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
            "<hp:t>한글 문서</hp:t></hp:p>",
        )
    file = upload(client, accounts, "sample.hwpx", raw.getvalue()).json()
    request = submit(
        client, accounts, {"operation": "convert", "source_file_id": file["id"], "format": "txt"}
    ).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + request["id"], headers=accounts["alice"]["headers"]
    ).json()
    assert result["status"] == "completed", result
    assert (
        client.get(
            "/v1/files/" + result["output_file_id"] + "/content",
            headers=accounts["alice"]["headers"],
        ).text
        == "한글 문서"
    )
    assert (
        submit(
            client,
            accounts,
            {"operation": "edit", "source_file_id": file["id"], "spec": {"text": "x"}},
        ).status_code
        == 422
    )
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as z:
        z.writestr("word/vbaProject.bin", b"danger")
    file = upload(client, accounts, "macro.docx", raw.getvalue()).json()
    request = submit(client, accounts, {"operation": "read", "source_file_id": file["id"]}).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + request["id"], headers=accounts["alice"]["headers"]
    ).json()
    assert result["status"] == "failed"


def test_expired_trash_releases_quota_without_deleting_job_history(client, accounts, sessions):
    from mori.artifacts.service import purge_expired_files

    file = upload(client, accounts, "old.txt", b"old").json()
    path = "/v1/files/" + file["id"]
    h = accounts["alice"]["headers"]
    client.delete(path, headers=h)
    assert (
        purge_expired_files(
            sessions, client.app.state.settings, now=datetime.now(UTC) + timedelta(days=31)
        )
        == 1
    )
    assert client.post(path + "/restore", headers=h).status_code == 410
    with sessions() as s:
        row = s.get(StoredFile, file["id"])
        assert row.content == b"" and row.size_bytes == 0 and row.purged_at is not None


def test_hwpx_read_and_convert_preserve_numeric_section_order(client, accounts, sessions):
    raw = io.BytesIO()
    # ZIP entry order is unrelated to the document's numbered section order.
    with zipfile.ZipFile(raw, "w") as archive:
        for number in reversed(range(12)):
            archive.writestr(
                f"Contents/section{number}.xml",
                '<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
                f"<hp:t>문서 구역 {number}</hp:t></hp:p>",
            )
    source = upload(client, accounts, "sections.hwpx", raw.getvalue()).json()
    expected = "\n".join(f"문서 구역 {number}" for number in range(12))
    headers = accounts["alice"]["headers"]
    for operation in ("read", "convert"):
        payload = {"operation": operation, "source_file_id": source["id"]}
        if operation == "convert":
            payload["format"] = "txt"
        job = submit(client, accounts, payload).json()
        assert asyncio.run(run_document_once(sessions, client.app.state.settings))
        result = client.get("/v1/document-jobs/" + job["id"], headers=headers).json()
        assert result["status"] == "completed", result
        if operation == "read":
            assert result["result"]["data"]["text"] == expected
        else:
            output = client.get(
                "/v1/files/" + result["output_file_id"] + "/content", headers=headers
            )
            assert output.text == expected


def test_document_cancel_fences_worker_and_retry_keeps_history(client, accounts, sessions):
    from mori.artifacts.service import claim_job, process_document

    original_key = uuid4()
    job = submit(
        client,
        accounts,
        {"operation": "create", "format": "txt", "spec": {"text": "output"}},
        original_key,
    ).json()
    h = accounts["alice"]["headers"]
    url = "/v1/document-jobs/" + job["id"]
    claimed = claim_job(sessions)
    assert client.post(url + "/cancel", headers=accounts["bob"]["headers"]).status_code == 404
    cancelled = client.post(url + "/cancel", headers=h)
    assert cancelled.json()["status"] == "cancelled"
    process_document(sessions, client.app.state.settings, claimed)
    assert client.get(url, headers=h).json()["output_file_id"] is None
    assert client.get("/v1/files", headers=h).json() == []
    assert (
        client.post(url + "/retry", headers={**h, "Idempotency-Key": str(original_key)}).status_code
        == 409
    )
    retry_headers = {**h, "Idempotency-Key": str(uuid4())}
    retried = client.post(url + "/retry", headers=retry_headers)
    assert retried.status_code == 202, retried.text
    assert retried.json()["id"] != job["id"]
    assert client.post(url + "/retry", headers=retry_headers).json()["id"] == retried.json()["id"]
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    new_url = "/v1/document-jobs/" + retried.json()["id"]
    assert client.get(url, headers=h).json()["status"] == "cancelled"
    assert client.post(new_url + "/cancel", headers=h).json()["status"] == "completed"
    assert (
        client.post(new_url + "/retry", headers={**h, "Idempotency-Key": str(uuid4())}).status_code
        == 409
    )


def test_document_retry_rechecks_source_access(client, accounts, sessions):
    file = upload(client, accounts, "source.txt", b"data").json()
    job = submit(client, accounts, {"operation": "read", "source_file_id": file["id"]}).json()
    h = accounts["alice"]["headers"]
    path = "/v1/document-jobs/" + job["id"]
    client.post(path + "/cancel", headers=h)
    client.delete("/v1/files/" + file["id"], headers=h)
    assert (
        client.post(path + "/retry", headers={**h, "Idempotency-Key": str(uuid4())}).status_code
        == 404
    )


def test_large_unicode_spec_matches_worker_input_encoding(client, accounts, sessions):
    paragraphs = ["한" * 22500, "글" * 22500]
    accepted = submit(
        client,
        accounts,
        {"operation": "create", "format": "docx", "spec": {"paragraphs": paragraphs}},
    )
    assert accepted.status_code == 202, accepted.text
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    h = accounts["alice"]["headers"]
    done = client.get("/v1/document-jobs/" + accepted.json()["id"], headers=h).json()
    assert done["status"] == "completed", done
    content = client.get("/v1/files/" + done["output_file_id"] + "/content", headers=h).content
    assert [p.text for p in Document(io.BytesIO(content)).paragraphs] == paragraphs


def test_large_docx_read_returns_bounded_partial_preview(client, accounts, sessions):
    import json

    doc = Document()
    for _ in range(100):
        doc.add_paragraph("한글문서" * 250)
    data = io.BytesIO()
    doc.save(data)
    source = upload(client, accounts, "long.docx", data.getvalue()).json()
    read = submit(client, accounts, {"operation": "read", "source_file_id": source["id"]}).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + read["id"], headers=accounts["alice"]["headers"]
    ).json()
    assert result["status"] == "completed", result
    preview = result["result"]["data"]
    assert preview["text"].startswith("한글문서")
    assert preview["truncated"] and preview["body_paragraphs_truncated"]
    assert 0 < len(preview["body_paragraphs"]) < 100
    assert len(json.dumps(result["result"], ensure_ascii=False).encode()) < 200000


def test_large_excel_preview_and_conversion_report_truncation(client, accounts, sessions):
    import json

    from openpyxl import Workbook

    book = Workbook()
    for _ in range(101):
        book.active.append(["한글내용" * 300] * 30)
    data = io.BytesIO()
    book.save(data)
    book.close()
    source = upload(client, accounts, "large.xlsx", data.getvalue()).json()
    read = submit(client, accounts, {"operation": "read", "source_file_id": source["id"]}).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    h = accounts["alice"]["headers"]
    result = client.get("/v1/document-jobs/" + read["id"], headers=h).json()
    assert result["status"] == "completed", result
    preview = result["result"]["data"]
    sheet = preview["sheets"][0]
    assert (
        sheet["rows"] and sheet["cells_truncated"] and sheet["truncated"] and preview["truncated"]
    )
    assert len(json.dumps(result["result"], ensure_ascii=False).encode()) < 200000
    conversion = submit(
        client, accounts, {"operation": "convert", "format": "txt", "source_file_id": source["id"]}
    ).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    converted = client.get("/v1/document-jobs/" + conversion["id"], headers=h).json()
    assert converted["status"] == "completed", converted
    assert converted["result"]["data"]["source_truncated"]


def test_text_to_docx_conversion_does_not_drop_lines_after_200(client, accounts, sessions):
    text = "\n".join(f"line-{i}" for i in range(301))
    source = upload(client, accounts, "lines.txt", text.encode()).json()
    job = submit(
        client, accounts, {"operation": "convert", "format": "docx", "source_file_id": source["id"]}
    ).json()
    asyncio.run(run_document_once(sessions, client.app.state.settings))
    h = accounts["alice"]["headers"]
    converted = client.get("/v1/document-jobs/" + job["id"], headers=h).json()
    assert converted["status"] == "completed", converted
    content = client.get("/v1/files/" + converted["output_file_id"] + "/content", headers=h).content
    assert "\n".join(p.text for p in Document(io.BytesIO(content)).paragraphs) == text
    assert converted["result"]["data"]["source_truncated"] is False


def test_small_excel_read_and_conversion_do_not_claim_truncation(client, accounts, sessions):
    from openpyxl import Workbook

    book = Workbook()
    book.active.append(["항목", "수량"])
    book.active.append(["책", 3])
    data = io.BytesIO()
    book.save(data)
    book.close()
    source = upload(client, accounts, "small.xlsx", data.getvalue()).json()
    h = accounts["alice"]["headers"]
    for operation in ("read", "convert"):
        payload = {"operation": operation, "source_file_id": source["id"]}
        if operation == "convert":
            payload["format"] = "txt"
        job = submit(client, accounts, payload).json()
        asyncio.run(run_document_once(sessions, client.app.state.settings))
        finished = client.get("/v1/document-jobs/" + job["id"], headers=h).json()
        assert finished["status"] == "completed", finished
        result = finished["result"]["data"]
        if operation == "read":
            assert result["truncated"] is False
            assert result["sheets"][0]["truncated"] is False
            assert not result["sheets"][0].get("cells_truncated", False)
            assert result["sheets"][0]["rows"] == [["항목", "수량"], ["책", 3]]
        else:
            assert result["source_truncated"] is False


def test_docx_read_and_convert_preserve_nested_table_content(tmp_path):
    from mori.artifacts.engine import convert, execute

    document = Document()
    document.add_paragraph("문서 시작")
    cell = document.add_table(rows=1, cols=1).cell(0, 0)
    cell.paragraphs[0].text = "바깥 셀 시작"
    nested = cell.add_table(rows=1, cols=2)
    nested.cell(0, 0).text = "중첩 표 첫째 셀"
    deeper = nested.cell(0, 1)
    deeper.paragraphs[0].text = "둘째 셀 시작"
    deeper.add_table(rows=1, cols=1).cell(0, 0).text = "더 안쪽 표 본문"
    deeper.paragraphs[-1].text = "둘째 셀 끝"
    cell.paragraphs[-1].text = "바깥 셀 끝"
    document.add_paragraph("문서 끝")
    filename = "a" * 32 + ".docx"
    document.save(tmp_path / filename)
    expected = (
        "문서 시작\n바깥 셀 시작\n중첩 표 첫째 셀\t둘째 셀 시작\n"
        "더 안쪽 표 본문\n둘째 셀 끝\n바깥 셀 끝\n문서 끝"
    )
    read = execute({"operation": "read", "file_id": filename}, tmp_path)
    assert read["data"]["text"] == expected
    assert read["data"]["truncated"] is False
    assert read["data"]["body_paragraphs"] == [
        {"index": 0, "text": "문서 시작"},
        {"index": 1, "text": "문서 끝"},
    ]
    converted = convert({"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path)
    assert (tmp_path / converted["file_id"]).read_text() == expected
    assert converted["data"]["source_truncated"] is False


def test_docx_nested_table_preview_and_conversion_are_bounded(tmp_path):
    from mori.artifacts.engine import MAX_TEXT, convert, execute

    document = Document()
    outer = document.add_table(rows=1, cols=1).cell(0, 0)
    outer.paragraphs[0].text = "prefix"
    outer.add_table(rows=1, cols=1).cell(0, 0).text = "N" * (MAX_TEXT + 100)
    filename = "b" * 32 + ".docx"
    document.save(tmp_path / filename)
    read = execute({"operation": "read", "file_id": filename}, tmp_path)
    expected = ("prefix\n" + "N" * (MAX_TEXT + 100))[:MAX_TEXT]
    assert read["data"]["text"] == expected
    assert read["data"]["truncated"] is True
    converted = convert({"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path)
    assert (tmp_path / converted["file_id"]).read_text() == expected
    assert converted["data"]["source_truncated"] is True


def test_docx_excessive_table_nesting_fails_closed(tmp_path):
    import pytest

    from mori.artifacts.engine import convert, execute

    document = Document()
    cell = document.add_table(rows=1, cols=1).cell(0, 0)
    for _ in range(64):
        cell = cell.add_table(rows=1, cols=1).cell(0, 0)
    cell.text = "deep content"
    filename = "c" * 32 + ".docx"
    document.save(tmp_path / filename)
    with pytest.raises(ValueError, match="table nesting"):
        execute({"operation": "read", "file_id": filename}, tmp_path)
    with pytest.raises(ValueError, match="table nesting"):
        convert({"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path)


def test_hwp_read_and_convert_invoke_provider_cli_main(tmp_path, monkeypatch):
    from mori.artifacts.engine import convert, execute

    # pyhwp exposes a console-entry-point main without a module main guard.
    # Exercise that contract in a real subprocess without a third-party HWP fixture.
    package = tmp_path / "hwp5"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "hwp5txt.py").write_text(
        "import sys\n"
        "from pathlib import Path\n"
        "def main():\n"
        "    value = Path(sys.argv[1]).read_bytes()\n"
        "    if not value.startswith(b'controlled-hwp:'):\n"
        "        raise ValueError('Invalid controlled HWP')\n"
        "    sys.stdout.write(value[len(b'controlled-hwp:'):].decode('utf-8'))\n"
    )
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    filename = "d" * 32 + ".hwp"
    expected = "한글 본문\n둘째 문단"
    (tmp_path / filename).write_bytes(b"controlled-hwp:" + expected.encode())
    read = execute({"operation": "read", "file_id": filename}, tmp_path)
    assert read["data"] == {"text": expected, "truncated": False}
    converted = convert({"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path)
    assert (tmp_path / converted["file_id"]).read_text() == expected
    assert converted["data"]["source_truncated"] is False


def test_hwp_installed_parser_rejects_invalid_binary(tmp_path):
    import subprocess

    import pytest

    from mori.artifacts.engine import execute

    filename = "e" * 32 + ".hwp"
    (tmp_path / filename).write_bytes(b"not an HWP document")
    with pytest.raises(subprocess.CalledProcessError) as rejected:
        execute({"operation": "read", "file_id": filename}, tmp_path)
    # An unavailable runtime dependency is not evidence that the parser ran.
    assert b"ModuleNotFoundError" not in rejected.value.stderr
