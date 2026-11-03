"""Small document worker. Fixed workspace, new outputs, no network or code execution.

Invoked only in a per-job scratch directory by the authenticated artifact service.
"""

import io
import json
import math
import os
import re
import sys
import uuid
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

MAX_FILE = 10_000_000
MAX_TEXT = 40_000
FONT = Path(os.environ.get("MORI_DOCUMENT_FONT", "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"))


def fields(obj, allowed):
    if not isinstance(obj, dict) or set(obj) - set(allowed):
        raise ValueError("Unsupported fields")


def text(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise ValueError("Expected text of at most 40000 characters")
    if any(ord(c) < 32 and c not in "\n\t\r" for c in value):
        raise ValueError("Control characters are not supported")
    return value


def items(value, maximum=200):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"Expected a list with at most {maximum} items")
    return value


def index(value, maximum):
    if type(value) is not int or not 0 <= value < maximum:
        raise ValueError("Index out of range")
    return value


def cell_value(value):
    if value is None or type(value) is bool:
        return value
    if type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e100:
        return value
    if isinstance(value, str) and len(value) <= 32767:
        return text(value)
    raise ValueError("Invalid spreadsheet value")


def json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, default=str).encode())


def preview_string(value, byte_limit):
    """Keep a Unicode prefix whose serialized size fits, including JSON escaping."""
    if json_bytes(value) <= byte_limit:
        return value
    low, high = 0, min(len(value), byte_limit)
    while low < high:
        middle = (low + high + 1) // 2
        if json_bytes(value[:middle]) <= byte_limit:
            low = middle
        else:
            high = middle - 1
    return value[:low]


def bounded_preview(details):
    """Return useful partial data instead of rejecting a supported, large document."""
    truncated = details.get("truncated", False)
    if "text" in details:
        original = details["text"]
        details["text"] = preview_string(original, 100_000)
        truncated |= details["text"] != original
    if "body_paragraphs" in details:
        remaining, paragraphs = 60_000, []
        for item in details["body_paragraphs"]:
            size = json_bytes(item) + 2
            if size > remaining:
                break
            paragraphs.append(item)
            remaining -= size
        details["body_paragraphs_truncated"] = details.get(
            "body_paragraphs_truncated", False
        ) or len(paragraphs) != len(details["body_paragraphs"])
        details["body_paragraphs"] = paragraphs
    if "sheets" in details:
        remaining = 160_000
        for sheet in details["sheets"]:
            original_name = sheet["name"]
            sheet["name"] = preview_string(original_name, 500)
            sheet["truncated"] |= sheet["name"] != original_name
            remaining -= json_bytes(sheet["name"]) + 200
            rows = []
            for row in sheet["rows"]:
                bounded_row = [preview_string(c, 1200) if isinstance(c, str) else c for c in row]
                if bounded_row != list(row):
                    sheet["cells_truncated"] = True
                    sheet["truncated"] = True
                size = json_bytes(bounded_row) + 2
                if size > remaining:
                    break
                rows.append(bounded_row)
                remaining -= size
            sheet["truncated"] |= len(rows) != len(sheet["rows"])
            sheet["rows"] = rows
            truncated |= sheet["truncated"]
        truncated |= details.get("sheets_truncated", False)
    details["truncated"] = truncated
    return details


def read_input(root, file_id):
    if not isinstance(file_id, str) or not re.fullmatch(
        r"[0-9a-f]{32}\.(docx|xlsx|pdf|hwpx|hwp|txt|md|csv)", file_id
    ):
        raise ValueError("Invalid file_id")
    fd = os.open(root / file_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        import stat

        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Expected a regular file")
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError("Input exceeds 10 MB")
    fmt = file_id.rsplit(".", 1)[1]
    if fmt in ("docx", "xlsx", "hwpx"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(e.file_size for e in entries) > 50_000_000:
                raise ValueError("Office archive exceeds expansion limits")
            if any(e.flag_bits & 1 or "vbaproject" in e.filename.lower() for e in entries):
                raise ValueError("Encrypted or macro-enabled Office files are unsupported")
    return fmt, io.BytesIO(data)


def word(operation, source, spec):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph

    doc = Document(source) if source else Document()
    if operation == "read":
        # Keep edit indices tied to the original top-level body paragraphs.
        # python-docx omits structured document tags and simple fields from
        # block/run iteration. Expose only their cached display content in this
        # read-only DOM; field instructions are never executed or refreshed.
        body_paragraphs = doc.paragraphs
        for control in doc._element.xpath(".//w:sdt | .//w:fldSimple"):
            content = control.find(qn("w:sdtContent")) if control.tag == qn("w:sdt") else control
            if content is not None:
                for child in list(content):
                    control.addprevious(child)
                control.getparent().remove(control)

        def fragments(container, depth=0):
            if depth > 64:
                raise ValueError("Word table nesting exceeds 64 levels")
            first = True
            for block in container.iter_inner_content():
                if isinstance(block, Paragraph):
                    if not first:
                        yield "\n"
                    yield block.text
                    first = False
                else:
                    # row.cells expands merged cells into every occupied grid
                    # position. Read their shared XML cell once, retaining blank
                    # grid positions so column and row separators stay stable.
                    seen_cells = set()
                    for row in block.rows:
                        if not first:
                            yield "\n"
                        first = False
                        for column, cell in enumerate(row.cells):
                            if column:
                                yield "\t"
                            if cell._tc in seen_cells:
                                continue
                            seen_cells.add(cell._tc)
                            yield from fragments(cell, depth + 1)

        # Preserve the paragraph/row separators without building an unbounded
        # nested-table string. One extra character records a truncated preview.
        values, remaining = [], MAX_TEXT + 1
        for part in fragments(doc):
            values.append(part[:remaining])
            remaining -= len(values[-1])
            if remaining == 0:
                break
        content = "".join(values)
        return {
            "text": content[:MAX_TEXT],
            "truncated": len(content) > MAX_TEXT,
            "body_paragraphs": [
                {"index": i, "text": p.text[:1000]} for i, p in enumerate(body_paragraphs[:100])
            ],
            "body_paragraphs_truncated": len(body_paragraphs) > 100
            or any(len(p.text) > 1000 for p in body_paragraphs[:100]),
        }, None
    if operation == "create":
        fields(spec, ("title", "paragraphs"))
        if spec.get("title"):
            doc.add_heading(text(spec["title"]), 0)
        for p in items(spec.get("paragraphs", [])):
            doc.add_paragraph(text(p))
    else:
        fields(spec, ("paragraph_updates", "append_paragraphs"))
        if not spec.get("paragraph_updates") and not spec.get("append_paragraphs"):
            raise ValueError("No Word edits supplied")
        for update in items(spec.get("paragraph_updates", [])):
            fields(update, ("index", "text"))
            doc.paragraphs[index(update["index"], len(doc.paragraphs))].text = text(update["text"])
        for p in items(spec.get("append_paragraphs", [])):
            doc.add_paragraph(text(p))
    out = io.BytesIO()
    doc.save(out)
    # Validate the saved package by loading it again.
    Document(io.BytesIO(out.getvalue()))
    return {"notice": "Body paragraph editing; replaced paragraphs lose inline run styling."}, out


def excel(operation, source, spec):
    from openpyxl import Workbook, load_workbook
    from openpyxl.utils.cell import coordinate_to_tuple

    book = load_workbook(source, keep_links=False) if source else Workbook()
    if operation == "read":
        sheets = []
        for sheet in book.worksheets[:10]:
            rows = list(
                sheet.iter_rows(
                    min_row=1,
                    max_row=min(sheet.max_row, 100),
                    max_col=min(sheet.max_column, 30),
                    values_only=True,
                )
            )
            sheets.append(
                {
                    "name": sheet.title,
                    "rows": rows,
                    "truncated": sheet.max_row > 100 or sheet.max_column > 30,
                }
            )
        return {
            "sheets": sheets,
            "sheets_truncated": len(book.worksheets) > 10,
            "formulas_calculated": False,
        }, None
    if operation == "create":
        fields(spec, ("sheet", "rows"))
        sheet = book.active
        sheet.title = text(spec.get("sheet", "Sheet1"))
        for row in items(spec.get("rows", []), 1000):
            sheet.append([cell_value(v) for v in items(row, 50)])
    else:
        fields(spec, ("sheet", "cells"))
        sheet = book[text(spec.get("sheet", book.active.title))]
        updates = items(spec.get("cells", []), 500)
        if not updates:
            raise ValueError("No cell edits supplied")
        for update in updates:
            fields(update, ("cell", "value"))
            address = update.get("cell")
            if not isinstance(address, str) or not re.fullmatch(
                r"[A-Z]{1,3}[1-9][0-9]{0,3}", address
            ):
                raise ValueError("Invalid cell address")
            row, col = coordinate_to_tuple(address)
            if row > 1000 or col > 50:
                raise ValueError("Cell edit exceeds 1000 rows / 50 columns")
            sheet[address] = cell_value(update.get("value"))
    out = io.BytesIO()
    book.save(out)
    check = load_workbook(io.BytesIO(out.getvalue()))
    check.close()
    book.close()
    return {
        "formulas_calculated": False,
        "notice": "Basic cell edits; complex Excel features may not survive openpyxl.",
    }, out


def pdf(operation, source, spec):
    from pypdf import PdfReader, PdfWriter

    if operation == "create":
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

        fields(spec, ("title", "paragraphs"))
        pdfmetrics.registerFont(TTFont("MoriKorean", str(FONT)))
        style = ParagraphStyle(
            "Mori", fontName="MoriKorean", fontSize=11, leading=17, wordWrap="CJK"
        )
        out = io.BytesIO()
        flow = []
        for value in ([spec["title"]] if spec.get("title") else []) + items(
            spec.get("paragraphs", [])
        ):
            flow.extend(
                [Paragraph(escape(text(value)).replace("\n", "<br/>"), style), Spacer(1, 10)]
            )
        if not flow:
            raise ValueError("PDF needs at least one paragraph")
        SimpleDocTemplate(out).build(flow)
        PdfReader(io.BytesIO(out.getvalue()))
        return {"notice": "Korean font embedded; rendered layout not visually verified."}, out
    reader = PdfReader(source)
    if reader.is_encrypted or len(reader.pages) > 100:
        raise ValueError("Encrypted PDFs or PDFs over 100 pages are unsupported")
    if operation == "read":
        content = "\n".join((p.extract_text() or "") for p in reader.pages)
        return {
            "pages": len(reader.pages),
            "text": content[:MAX_TEXT],
            "truncated": len(content) > MAX_TEXT,
            "ocr_performed": False,
        }, None
    fields(spec, ("pages", "rotate"))
    pages = items(spec.get("pages", list(range(1, len(reader.pages) + 1))), 100)
    angle = spec.get("rotate", 0)
    if type(angle) is not int or angle not in (0, 90, 180, 270):
        raise ValueError("Rotation must be 0, 90, 180 or 270")
    if not pages:
        raise ValueError("PDF must keep at least one page")
    writer = PdfWriter()
    for page in pages:
        if type(page) is not int:
            raise ValueError("Page numbers must be integers")
        copied = writer.add_page(reader.pages[index(page - 1, len(reader.pages))])
        copied.rotate(angle)
    out = io.BytesIO()
    writer.write(out)
    PdfReader(io.BytesIO(out.getvalue()))
    return {
        "pages": len(pages),
        "notice": "Page selection/order/rotation only; no PDF text edits.",
    }, out


def execute(args, root):
    fields(args, ("operation", "format", "file_id", "spec"))
    operation = args.get("operation")
    if operation not in ("create", "read", "edit"):
        raise ValueError("Unknown operation")
    if root.is_symlink():
        raise ValueError("Workspace must not be a symlink")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = None
    if operation == "create":
        if "file_id" in args:
            raise ValueError("Create cannot overwrite a file_id")
        fmt = args.get("format")
    else:
        if "format" in args:
            raise ValueError("Read/edit infer the format from file_id")
        fmt, source = read_input(root, args.get("file_id"))
    spec = args.get("spec", {})
    if not isinstance(spec, dict) or (operation == "read" and spec):
        raise ValueError("Invalid spec")
    handlers = {
        "docx": word,
        "xlsx": excel,
        "pdf": pdf,
        "hwpx": hangul_xml,
        "hwp": hangul_binary,
        "txt": plain_text,
        "md": plain_text,
        "csv": plain_text,
    }
    if fmt not in handlers:
        raise ValueError("Only docx, xlsx and pdf are supported")
    details, out = handlers[fmt](operation, source, spec)
    result = {
        "success": True,
        "format": fmt,
        "data": details,
        "external_data_untrusted": True,
        "render_verified": False,
    }
    if out is None:
        result["file_id"] = args["file_id"]
        result["data"] = bounded_preview(details)
        # A final invariant check also covers unforeseen parser metadata expansion.
        if len(json.dumps(result, ensure_ascii=False, default=str).encode()) > 200_000:
            raise ValueError("Preview exceeds 200 KB; use a smaller input document")
        return result
    data = out.getvalue()
    if len(data) > MAX_FILE:
        raise ValueError("Output exceeds 10 MB")
    file_id = uuid.uuid4().hex + "." + fmt
    fd = os.open(root / file_id, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
    result.update(file_id=file_id, bytes=len(data), source_file_id=args.get("file_id"))
    return result


def plain_text(operation, source, spec):
    if operation == "read":
        value = source.read().decode("utf-8-sig")
        return {"text": value[:MAX_TEXT], "truncated": len(value) > MAX_TEXT}, None
    fields(spec, ("text",))
    return {}, io.BytesIO(text(spec.get("text", "")).encode("utf-8"))


def hangul_xml(operation, source, spec):
    if operation != "read":
        raise ValueError("HWPX supports text extraction; convert to DOCX for editing")
    from defusedxml import ElementTree

    with zipfile.ZipFile(source) as archive:
        values, remaining = [], MAX_TEXT + 1
        sections = []
        for name in archive.namelist():
            match = re.fullmatch(r"Contents/section([0-9]+)[.]xml", name)
            if match:
                sections.append((int(match[1]), name))
        for _, name in sorted(sections):
            tree = ElementTree.fromstring(archive.read(name))
            previous = None
            # Runs in one paragraph concatenate. Entering or returning from a
            # table's nested paragraph starts a new line without rereading it.
            for paragraph, part in hangul_fragments(tree):
                if paragraph is not previous and values:
                    values.append("\n")
                    remaining -= 1
                previous = paragraph
                values.append(part[:remaining])
                remaining -= len(values[-1])
                if remaining == 0:
                    break
            if remaining == 0:
                break
        value = "".join(values)
    return {"text": value[:MAX_TEXT], "truncated": len(value) > MAX_TEXT}, None


def hangul_fragments(tree):
    """Visit each paragraph/run once, including inline text after controls."""
    namespace = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    controls = {namespace + "lineBreak": "\n", namespace + "tab": "\t"}
    paragraphs = []
    text_depth = 0
    # Iterator frames keep deeply nested input off Python's call stack.
    frames = [(tree, None)]
    while frames:
        node, children = frames[-1]
        if children is None:
            frames[-1] = (node, iter(node))
            if node.tag == namespace + "p":
                paragraphs.append([object(), False])
            if node.tag == namespace + "t" and paragraphs:
                text_depth += 1
                paragraphs[-1][1] = True
                yield paragraphs[-1][0], node.text or ""
            elif text_depth and paragraphs and node.tag in controls:
                yield paragraphs[-1][0], controls[node.tag]
            continue
        child = next(children, None)
        if child is not None:
            frames.append((child, None))
            continue
        frames.pop()
        if node.tag == namespace + "t" and paragraphs:
            text_depth -= 1
        elif node.tag == namespace + "p":
            paragraph, populated = paragraphs.pop()
            if not populated:
                yield paragraph, ""
            if paragraphs:
                paragraphs[-1][1] = True
        if text_depth and paragraphs and node.tail:
            yield paragraphs[-1][0], node.tail


def hangul_binary(operation, source, spec):
    if operation != "read":
        raise ValueError("HWP supports text extraction; convert to DOCX for editing")
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".hwp") as file:
        file.write(source.read())
        file.flush()
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from hwp5.hwp5txt import main; raise SystemExit(main())",
                file.name,
            ],
            capture_output=True,
            timeout=20,
            check=True,
        )
    value = result.stdout.decode("utf-8")
    return {"text": value[:MAX_TEXT], "truncated": len(value) > MAX_TEXT}, None


def preview_text(details):
    if "text" in details:
        return details["text"]
    return "\n".join(
        "\t".join(str(c) if c is not None else "" for c in row)
        for sheet in details.get("sheets", [])
        for row in sheet["rows"]
    )


def convert(args, root):
    fields(args, ("operation", "format", "file_id", "spec"))
    result = execute({"operation": "read", "file_id": args["file_id"]}, root)
    fmt = args.get("format")
    if fmt not in ("txt", "md", "docx", "pdf"):
        raise ValueError("Conversion target must be txt/md/docx/pdf")
    extracted = preview_text(result["data"])
    content = extracted[:MAX_TEXT]
    if not content.strip():
        raise ValueError("No extractable text; OCR is not performed")
    paragraphs = content.splitlines()
    if len(paragraphs) > 200:
        paragraphs = paragraphs[:199] + ["\n".join(paragraphs[199:])]
    spec = {"text": content} if fmt in ("txt", "md") else {"paragraphs": paragraphs}
    output = execute({"operation": "create", "format": fmt, "spec": spec}, root)
    output["data"]["conversion_mode"] = "text_reflow"
    output["data"]["source_truncated"] = (
        result["data"].get("truncated", False) or len(extracted) > MAX_TEXT
    )
    return output


if __name__ == "__main__":
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (12_000_000, 12_000_000))
        raw = sys.stdin.buffer.read(256_001)
        if len(raw) > 256_000:
            raise ValueError("Request too large")
        args = json.loads(raw)
        result = (convert if args.get("operation") == "convert" else execute)(args, Path.cwd())
    except Exception as exc:
        result = {
            "success": False,
            "error_code": "DOCUMENT_PROCESSING_FAILED",
            "error_type": type(exc).__name__,
        }
    print(json.dumps(result, ensure_ascii=False, default=str))
