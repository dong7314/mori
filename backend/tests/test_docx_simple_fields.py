import json
import subprocess
import sys
from pathlib import Path

import pytest
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from mori.artifacts import engine

ENGINE_PATH = Path(engine.__file__)


def _field(paragraph, display):
    run = paragraph.add_run(display)._r
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "REF private_account_instruction \\h")
    run.addprevious(field)
    field.append(run)
    # Field instructions in runs are also metadata, not visible cached output.
    instruction = OxmlElement("w:instrText")
    instruction.text = "private instruction text"
    run.insert(0, instruction)
    return field


def _control(element):
    control = OxmlElement("w:sdt")
    properties = OxmlElement("w:sdtPr")
    alias = OxmlElement("w:alias")
    alias.set(qn("w:val"), "private control properties")
    properties.append(alias)
    control.append(properties)
    content = OxmlElement("w:sdtContent")
    control.append(content)
    element.addprevious(control)
    content.append(element)
    return control


def _read(root, filename):
    return engine.execute({"operation": "read", "file_id": filename}, root)["data"]


@pytest.mark.parametrize("target", ["txt", "docx"])
def test_simple_fields_preserve_display_order_conversion_source_and_edit_indices(tmp_path, target):
    document = Document()
    paragraph = document.add_paragraph("계좌 ")
    _field(paragraph, "123-456-789")
    paragraph.add_run(" 확인")
    table = document.add_table(rows=1, cols=1)
    paragraph = table.cell(0, 0).paragraphs[0]
    _field(paragraph, "2026-11-03")
    document.add_paragraph("마지막 문단")
    filename = "a" * 32 + ".docx"
    document.save(tmp_path / filename)
    original = (tmp_path / filename).read_bytes()
    expected = "계좌 123-456-789 확인\n2026-11-03\n마지막 문단"

    read = _read(tmp_path, filename)
    assert read["text"] == expected
    assert read["body_paragraphs"] == [
        {"index": 0, "text": "계좌 123-456-789 확인"},
        {"index": 1, "text": "마지막 문단"},
    ]
    assert read["truncated"] is read["body_paragraphs_truncated"] is False
    converted = engine.convert(
        {"operation": "convert", "file_id": filename, "format": target}, tmp_path
    )
    output = tmp_path / converted["file_id"]
    actual = (
        "\n".join(p.text for p in Document(output).paragraphs)
        if target == "docx"
        else output.read_text()
    )
    assert actual == expected
    assert converted["data"]["source_truncated"] is False
    assert (tmp_path / filename).read_bytes() == original

    edited = engine.execute(
        {
            "operation": "edit",
            "file_id": filename,
            "spec": {"paragraph_updates": [{"index": 1, "text": "바뀐 마지막"}]},
        },
        tmp_path,
    )
    assert (
        _read(tmp_path, edited["file_id"])["text"]
        == expected.removesuffix("마지막 문단") + "바뀐 마지막"
    )
    assert (tmp_path / filename).read_bytes() == original


def test_simple_fields_compose_with_sdt_wrappers_and_hyperlinks(tmp_path):
    document = Document()
    paragraph = document.add_paragraph("앞 ")
    _control(_field(paragraph, "필드 안 결과"))
    paragraph.add_run(" 중간 ")
    field = _field(paragraph, "컨트롤 안 결과")
    _control(field[0])
    paragraph.add_run(" 링크 ")
    field = _field(paragraph, "링크 결과")
    hyperlink = OxmlElement("w:hyperlink")
    field.addprevious(hyperlink)
    hyperlink.append(field)
    paragraph.add_run(" 끝")
    filename = "b" * 32 + ".docx"
    document.save(tmp_path / filename)

    expected = "앞 필드 안 결과 중간 컨트롤 안 결과 링크 링크 결과 끝"
    read = _read(tmp_path, filename)
    assert read["text"] == expected
    assert read["body_paragraphs"] == [{"index": 0, "text": expected}]
    assert "private" not in read["text"]


def test_simple_field_cached_text_obeys_global_and_paragraph_preview_limits(tmp_path):
    document = Document()
    paragraph = document.add_paragraph()
    _field(paragraph, "x" * (engine.MAX_TEXT + 1))
    filename = "c" * 32 + ".docx"
    document.save(tmp_path / filename)

    read = _read(tmp_path, filename)
    assert read["text"] == "x" * engine.MAX_TEXT
    assert read["truncated"] is True
    assert read["body_paragraphs"] == [{"index": 0, "text": "x" * 1000}]
    assert read["body_paragraphs_truncated"] is True
    converted = engine.convert(
        {"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path
    )
    assert converted["data"]["source_truncated"] is True
    assert (tmp_path / converted["file_id"]).read_text() == "x" * engine.MAX_TEXT


def test_simple_field_visible_result_survives_real_document_worker(tmp_path):
    document = Document()
    paragraph = document.add_paragraph("납부액 ")
    _field(paragraph, "120,000원\t확인\n다음 줄")
    filename = "d" * 32 + ".docx"
    document.save(tmp_path / filename)
    process = subprocess.run(
        [sys.executable, str(ENGINE_PATH)],
        input=json.dumps({"operation": "read", "file_id": filename}).encode(),
        cwd=tmp_path,
        capture_output=True,
        timeout=10,
        check=True,
    )
    result = json.loads(process.stdout)
    assert result["success"] is True, result
    assert result["data"]["text"] == "납부액 120,000원\t확인\n다음 줄"
    assert result["data"]["truncated"] is False
