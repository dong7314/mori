import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "backend/hermes/plugins/mori_documents/worker.py"


def field(paragraph, value):
    run = paragraph.add_run(value)._r
    wrapper = OxmlElement("w:fldSimple")
    wrapper.set(qn("w:instr"), "REF private_field_instruction")
    run.addprevious(wrapper)
    wrapper.append(run)
    instruction = OxmlElement("w:instrText")
    instruction.text = "private instruction text"
    run.insert(0, instruction)
    return wrapper


def control(*elements):
    wrapper = OxmlElement("w:sdt")
    properties = OxmlElement("w:sdtPr")
    alias = OxmlElement("w:alias")
    alias.set(qn("w:val"), "private control properties")
    properties.append(alias)
    wrapper.append(properties)
    content = OxmlElement("w:sdtContent")
    wrapper.append(content)
    elements[0].addprevious(wrapper)
    for element in elements:
        content.append(element)
    return wrapper


class DocumentReadingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.root = self.home / "documents"
        self.root.mkdir()

    def call(self, operation, **kwargs):
        # The production worker's RLIMIT_AS is unsupported on macOS. Only the
        # local test bootstrap bypasses it; Linux runs every original limit.
        bootstrap = """
import resource
import runpy
import sys
if sys.platform == "darwin":
    original = resource.setrlimit
    def setrlimit(kind, value):
        if kind != resource.RLIMIT_AS:
            original(kind, value)
    resource.setrlimit = setrlimit
runpy.run_path(sys.argv[1], run_name="__main__")
"""
        process = subprocess.run(
            [sys.executable, "-c", bootstrap, str(WORKER)],
            input=json.dumps({"operation": operation, **kwargs}).encode(),
            capture_output=True,
            timeout=10,
            check=True,
            env={**os.environ, "HERMES_HOME": str(self.home)},
        )
        return json.loads(process.stdout)

    def save(self, document, letter="a"):
        file_id = letter * 32 + ".docx"
        document.save(self.root / file_id)
        return file_id

    def test_worker_preserves_field_sdt_nested_table_order_source_and_edit_indices(self):
        document = Document()
        document.add_paragraph("문서 시작")
        controlled = document.add_paragraph("컨트롤 문단")
        table = document.add_table(rows=1, cols=1)
        cell = table.cell(0, 0)
        cell.paragraphs[0].text = "셀 시작"
        nested = cell.add_table(rows=1, cols=1)
        field(nested.cell(0, 0).paragraphs[0], "123-456-789")
        cell.paragraphs[-1].text = "셀 끝"
        control(control(controlled._p), table._tbl)
        document.add_paragraph("문서 끝")
        file_id = self.save(document)
        original = (self.root / file_id).read_bytes()
        expected = "문서 시작\n컨트롤 문단\n셀 시작\n123-456-789\n셀 끝\n문서 끝"

        result = self.call("read", file_id=file_id)
        self.assertTrue(result["success"], result)
        self.assertEqual(result["data"]["text"], expected)
        self.assertFalse(result["data"]["truncated"])
        self.assertFalse(result["data"]["body_paragraphs_truncated"])
        self.assertEqual(
            result["data"]["body_paragraphs"],
            [{"index": 0, "text": "문서 시작"}, {"index": 1, "text": "문서 끝"}],
        )
        self.assertEqual((self.root / file_id).read_bytes(), original)
        edited = self.call(
            "edit",
            file_id=file_id,
            spec={"paragraph_updates": [{"index": 1, "text": "변경한 끝"}]},
        )
        self.assertTrue(edited["success"], edited)
        reread = self.call("read", file_id=edited["file_id"])
        self.assertTrue(reread["success"], reread)
        self.assertEqual(reread["data"]["text"], expected.removesuffix("문서 끝") + "변경한 끝")
        self.assertEqual((self.root / file_id).read_bytes(), original)

    def test_worker_fields_compose_with_inline_controls_and_hyperlinks_without_metadata(self):
        document = Document()
        paragraph = document.add_paragraph("앞 ")
        control(field(paragraph, "123\t456\n확인"))
        paragraph.add_run(" 중간 ")
        wrapped = field(paragraph, "표시 결과")
        control(wrapped[0])
        paragraph.add_run(" 링크 ")
        wrapped = field(paragraph, "링크 결과")
        hyperlink = OxmlElement("w:hyperlink")
        wrapped.addprevious(hyperlink)
        hyperlink.append(wrapped)
        paragraph.add_run(" 끝")
        result = self.call("read", file_id=self.save(document))
        self.assertTrue(result["success"], result)
        expected = "앞 123\t456\n확인 중간 표시 결과 링크 링크 결과 끝"
        self.assertEqual(result["data"]["text"], expected)
        self.assertEqual(result["data"]["body_paragraphs"], [{"index": 0, "text": expected}])
        self.assertNotIn("private", result["data"]["text"])

    def test_worker_reports_whole_text_and_paragraph_preview_truncation(self):
        document = Document()
        field(document.add_paragraph(), "x" * 40001)
        for _ in range(100):
            document.add_paragraph("after")
        result = self.call("read", file_id=self.save(document))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["data"]["text"], "x" * 40000)
        self.assertTrue(result["data"]["truncated"])
        self.assertEqual(len(result["data"]["body_paragraphs"]), 100)
        self.assertEqual(result["data"]["body_paragraphs"][0], {"index": 0, "text": "x" * 1000})
        self.assertTrue(result["data"]["body_paragraphs_truncated"])

    def nested_document(self, depth):
        document = Document()
        cell = document.add_table(rows=1, cols=1).cell(0, 0)
        for _ in range(depth - 1):
            cell = cell.add_table(rows=1, cols=1).cell(0, 0)
        field(cell.paragraphs[0], "가장 안쪽")
        return document

    def test_worker_reads_supported_table_depth_boundary(self):
        result = self.call("read", file_id=self.save(self.nested_document(64)))
        self.assertTrue(result["success"], result)
        self.assertIn("가장 안쪽", result["data"]["text"])

    def test_worker_rejects_excessive_table_depth(self):
        result = self.call("read", file_id=self.save(self.nested_document(65)))
        self.assertFalse(result["success"], result)
        self.assertNotIn("data", result)


if __name__ == "__main__":
    unittest.main()
