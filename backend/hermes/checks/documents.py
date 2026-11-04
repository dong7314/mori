"""Offline image acceptance: invoke the real plugin/venv, then re-read edited files."""

import argparse
import importlib.util
import json
import os
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-toolset", action="store_true")
    args = parser.parse_args()
    if args.require_toolset:
        from runtime import http

        tools = http("http://127.0.0.1:8642/v1/toolsets", os.environ["API_SERVER_KEY"]).get(
            "data", []
        )
        if not any(
            t.get("name") == "mori_documents" and t.get("enabled") and t.get("configured")
            for t in tools
        ):
            raise ValueError("mori_documents toolset must be enabled and configured")
        print("PASS: running gateway exposes mori_documents")
    spec = importlib.util.spec_from_file_location(
        "mori_documents", "/opt/mori/plugins/mori_documents/__init__.py"
    )
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    previous = os.environ.get("HERMES_HOME")
    try:
        with tempfile.TemporaryDirectory(prefix="mori-documents-check-") as tmp:
            os.environ["HERMES_HOME"] = tmp

            def call(operation, **kwargs):
                result = json.loads(plugin.document({"operation": operation, **kwargs}))
                if result.get("success") is not True:
                    raise ValueError(str(result))
                return result

            for fmt in ("docx", "xlsx", "pdf"):
                content = {"paragraphs": ["모리 문서 테스트: 주차 위치 지하 2층 C36"]}
                if fmt == "xlsx":
                    content = {"sheet": "여행", "rows": [["항목", "금액"], ["식사", 10000]]}
                created = call("create", format=fmt, spec=content)
                file_id = created["file_id"]
                original = (Path(tmp) / "documents" / file_id).read_bytes()
                read = call("read", file_id=file_id)
                if fmt != "xlsx" and "주차 위치 지하 2층" not in read["data"]["text"]:
                    raise ValueError("Korean text did not round-trip")
                edits = {
                    "docx": {"paragraph_updates": [{"index": 0, "text": "변경: 지하 3층"}]},
                    "xlsx": {"sheet": "여행", "cells": [{"cell": "B2", "value": 15000}]},
                    "pdf": {"pages": [1], "rotate": 90},
                }
                edited = call("edit", file_id=file_id, spec=edits[fmt])
                changed = call("read", file_id=edited["file_id"])
                if fmt == "docx" and "변경: 지하 3층" not in changed["data"]["text"]:
                    raise ValueError("Word edit was not persisted")
                if fmt == "xlsx" and changed["data"]["sheets"][0]["rows"][1][1] != 15000:
                    raise ValueError("Cell edit was not persisted")
                if (Path(tmp) / "documents" / file_id).read_bytes() != original:
                    raise ValueError("Source document changed")
                print(f"PASS: {fmt} create/read/edit/read, original preserved")
            print(
                "PASS: real plugin subprocess and document libraries; no LLM, rendering or delivery"
            )
    finally:
        if previous is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous


if __name__ == "__main__":
    main()
