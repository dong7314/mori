import pytest
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from mori.artifacts.engine import MAX_TEXT, convert, execute


def _control(*elements):
    control = OxmlElement("w:sdt")
    properties = OxmlElement("w:sdtPr")
    alias = OxmlElement("w:alias")
    alias.set(qn("w:val"), "metadata is not document text")
    properties.append(alias)
    control.append(properties)
    content = OxmlElement("w:sdtContent")
    control.append(content)
    for element in elements:
        content.append(element)
    return control


def _wrap(*elements):
    first = elements[0]
    # Insert before moving the elements out of their original container.
    marker = OxmlElement("w:sdt")
    first.addprevious(marker)
    control = _control(*elements)
    marker.addprevious(control)
    marker.getparent().remove(marker)
    return control


def _converted_text(result, root):
    path = root / result["file_id"]
    if result["format"] == "docx":
        return "\n".join(paragraph.text for paragraph in Document(path).paragraphs)
    return path.read_text()


@pytest.mark.parametrize("target", ["txt", "docx"])
def test_docx_block_content_controls_preserve_text_order_and_edit_indices(tmp_path, target):
    document = Document()
    document.add_paragraph("문서 시작")
    controlled = document.add_paragraph("컨트롤 문단")
    table = document.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    cell.paragraphs[0].text = "셀 시작"
    nested = cell.add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "안쪽 표"
    cell.paragraphs[-1].text = "셀 끝"
    _wrap(cell.paragraphs[0]._p, nested._tbl, cell.paragraphs[-1]._p)
    _wrap(_wrap(controlled._p), table._tbl)
    document.add_paragraph("문서 끝")
    filename = "a" * 32 + ".docx"
    document.save(tmp_path / filename)
    original = (tmp_path / filename).read_bytes()
    expected = "문서 시작\n컨트롤 문단\n셀 시작\n안쪽 표\n셀 끝\n문서 끝"

    read = execute({"operation": "read", "file_id": filename}, tmp_path)["data"]
    assert read["text"] == expected
    assert read["truncated"] is False
    assert read["body_paragraphs"] == [
        {"index": 0, "text": "문서 시작"},
        {"index": 1, "text": "문서 끝"},
    ]
    converted = convert({"operation": "convert", "file_id": filename, "format": target}, tmp_path)
    assert _converted_text(converted, tmp_path) == expected
    assert converted["data"]["source_truncated"] is False
    assert (tmp_path / filename).read_bytes() == original

    edited = execute(
        {
            "operation": "edit",
            "file_id": filename,
            "spec": {"paragraph_updates": [{"index": 1, "text": "바뀐 끝"}]},
        },
        tmp_path,
    )
    assert (
        execute({"operation": "read", "file_id": edited["file_id"]}, tmp_path)["data"]["text"]
        == expected.removesuffix("문서 끝") + "바뀐 끝"
    )


@pytest.mark.parametrize("target", ["txt", "docx"])
def test_docx_inline_content_controls_preserve_runs_tabs_breaks_and_hyperlinks(tmp_path, target):
    document = Document()
    paragraph = document.add_paragraph("계좌 ")
    controlled_run = paragraph.add_run("1234\t5678\n확인")
    instruction = OxmlElement("w:instrText")
    instruction.text = "private field instruction is not visible text"
    controlled_run._r.insert(0, instruction)
    _wrap(_wrap(controlled_run._r))
    hyperlink = OxmlElement("w:hyperlink")
    linked_run = paragraph.add_run(" 링크\t본문\n계속")
    hyperlink.append(linked_run._r)
    paragraph._p.append(hyperlink)
    paragraph.add_run(" 끝")
    filename = "b" * 32 + ".docx"
    document.save(tmp_path / filename)
    expected = "계좌 1234\t5678\n확인 링크\t본문\n계속 끝"

    read = execute({"operation": "read", "file_id": filename}, tmp_path)["data"]
    assert read["text"] == expected
    assert read["body_paragraphs"] == [{"index": 0, "text": expected}]
    assert read["truncated"] is False
    converted = convert({"operation": "convert", "file_id": filename, "format": target}, tmp_path)
    assert _converted_text(converted, tmp_path) == expected
    assert converted["data"]["source_truncated"] is False


def test_docx_content_control_text_still_obeys_preview_limit(tmp_path):
    document = Document()
    paragraph = document.add_paragraph("x" * (MAX_TEXT + 100))
    _wrap(paragraph._p)
    filename = "c" * 32 + ".docx"
    document.save(tmp_path / filename)

    read = execute({"operation": "read", "file_id": filename}, tmp_path)["data"]
    assert read["text"] == "x" * MAX_TEXT
    assert read["truncated"] is True
    converted = convert({"operation": "convert", "file_id": filename, "format": "txt"}, tmp_path)
    assert (tmp_path / converted["file_id"]).read_text() == "x" * MAX_TEXT
    assert converted["data"]["source_truncated"] is True


def test_docx_inline_content_control_paragraph_preview_reports_truncation(tmp_path):
    document = Document()
    paragraph = document.add_paragraph("before ")
    _wrap(paragraph.add_run("x" * 1001)._r)
    paragraph.add_run(" after")
    filename = "d" * 32 + ".docx"
    document.save(tmp_path / filename)

    read = execute({"operation": "read", "file_id": filename}, tmp_path)["data"]
    expected = "before " + "x" * 1001 + " after"
    assert read["text"] == expected
    assert read["truncated"] is False
    assert read["body_paragraphs"] == [{"index": 0, "text": expected[:1000]}]
    assert read["body_paragraphs_truncated"] is True
