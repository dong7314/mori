import unittest

import test_document_reading as reading
from docx import Document


class MergedCellReadingTests(unittest.TestCase):
    setUp = reading.DocumentReadingTests.setUp
    call = reading.DocumentReadingTests.call
    save = reading.DocumentReadingTests.save

    # Use the existing real-worker bootstrap, but run only the new regression.
    def test_worker_reads_each_merged_cell_once(self):
        for direction, endpoint in (
            ("horizontal", (0, 1)),
            ("vertical", (1, 0)),
            ("rectangle", (1, 1)),
        ):
            with self.subTest(direction=direction):
                document = Document()
                document.add_paragraph("before")
                table = document.add_table(rows=3, cols=3)
                table.cell(0, 0).text = "unique merged amount 123-456"
                merged = table.cell(0, 0).merge(table.cell(*endpoint))
                if direction == "rectangle":
                    merged.paragraphs[0].add_run("x" * 12000)
                merged.add_table(rows=1, cols=1).cell(0, 0).text = "nested merged content"
                table.cell(0, 2).text = "row 0"
                table.cell(1, 2).text = "row 1"
                table.cell(2, 0).text = "same independent value"
                table.cell(2, 1).text = "same independent value"
                document.add_paragraph("after")
                file_id = self.save(document)
                original = (self.root / file_id).read_bytes()
                result = self.call("read", file_id=file_id)
                self.assertTrue(result["success"], result)
                value = result["data"]["text"]
                self.assertEqual(value.count("unique merged amount 123-456"), 1, value[:300])
                self.assertEqual(value.count("same independent value"), 2, value[:300])
                self.assertEqual(value.count("nested merged content"), 1, value[:300])
                self.assertFalse(result["data"]["truncated"])
                self.assertEqual(
                    result["data"]["body_paragraphs"],
                    [{"index": 0, "text": "before"}, {"index": 1, "text": "after"}],
                )
                self.assertEqual((self.root / file_id).read_bytes(), original)
