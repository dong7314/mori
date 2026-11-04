"""Local fixtures only. Does not connect to k3s, the model, or search providers."""

import contextlib
import copy
import importlib.util
import io
import json
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "checks"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load("image_plugin", ROOT / "plugins/mori_images/__init__.py")
checker = load("image_checker", ROOT / "checks/runtime.py")
checker.inspect = lambda payload: checker.verify(payload, "images")
checker.parse_result = checker.result_object
ROW = {
    "title": "경복궁 전경",
    "img_src": "https://images.example/a.jpg",
    "url": "https://example/photo",
    "engines": ["google images"],
}


class FakeResponse(io.BytesIO):
    pass


class Tests(unittest.TestCase):
    def search(self, payload, args=None):
        requests = []

        class Opener:
            def open(self, url, timeout):
                requests.append(url)
                return FakeResponse(json.dumps(payload).encode())

        with patch.object(plugin.urllib.request, "build_opener", return_value=Opener()):
            result = json.loads(plugin.search(args or {"query": "경복궁 전경"}))
        return result, requests

    def test_engine_is_explicit_and_deduplicates(self):
        result, requests = self.search({"results": [ROW, ROW]})
        self.assertTrue(result["success"])
        self.assertEqual(len(result["data"]["images"]), 1)
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(requests[0]).query)
        self.assertEqual(qs["q"], ["!goi 경복궁 전경"])
        self.assertNotIn("categories", qs)

    def test_mixed_engine_fails(self):
        row = dict(ROW, engines=["google images", "naver images"])
        result, _ = self.search({"results": [row]})
        self.assertFalse(result["success"])

    def test_product_and_bad_url_are_not_candidates(self):
        result, _ = self.search(
            {
                "results": [
                    dict(ROW, title="경복궁 직소퍼즐"),
                    dict(ROW, img_src="javascript:alert(1)"),
                ]
            }
        )
        self.assertFalse(result["success"])

    def test_captcha_is_not_success(self):
        result, _ = self.search(
            {"results": [], "unresponsive_engines": [["google images", "CAPTCHA"]]}
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["unresponsive_engines"][0][1], "CAPTCHA")

    def test_bang_injection_and_invalid_limit_do_not_request(self):
        for args in (
            {"query": "!naver x"},
            {"query": "경복궁", "limit": True},
            {"query": "경복궁", "limit": 9},
        ):
            result, requests = self.search({}, args)
            self.assertFalse(result["success"])
            self.assertEqual(requests, [])

    def test_registration_schema(self):
        captured = []

        class Context:
            def register_tool(self, **kw):
                captured.append(kw)

        plugin.register(Context())
        self.assertEqual(captured[0]["schema"]["name"], "mori_image_search")
        self.assertNotIn("override", captured[0])

    def test_real_call_evidence_required(self):
        result, _ = self.search({"results": [ROW]})
        payload = {
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "name": "mori_image_search",
                    "call_id": "a",
                    "arguments": "{}",
                },
                {"type": "function_call_output", "call_id": "a", "output": json.dumps(result)},
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": ROW["img_src"] + " " + ROW["url"]}],
                },
            ],
        }
        with contextlib.redirect_stdout(io.StringIO()):
            checker.inspect(payload)
            missing_call = copy.deepcopy(payload)
            missing_call["output"] = missing_call["output"][1:]
            with self.assertRaises(ValueError):
                checker.inspect(missing_call)
            wrong_url = copy.deepcopy(payload)
            wrong_url["output"][-1]["content"][0]["text"] = (
                "검색 성공! https://made-up.example/photo"
            )
            with self.assertRaises(ValueError):
                checker.inspect(wrong_url)

    def test_quoted_fake_success_does_not_parse(self):
        with self.assertRaises(ValueError):
            checker.parse_result('ERROR example: {"success":true,"data":{"images":[]}}')

    def bridge_payload(self, arguments, name="tool_call"):
        result, _ = self.search({"results": [ROW]})
        return {
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "name": name,
                    "call_id": "bridge-a",
                    "arguments": arguments,
                },
                {
                    "type": "function_call_output",
                    "call_id": "bridge-a",
                    "output": json.dumps(result),
                },
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": ROW["img_src"] + " " + ROW["url"]}],
                },
            ],
        }

    def test_supported_bridge_shapes(self):
        entry = {"name": "mori_image_search", "arguments": {"query": "경복궁 전경"}}
        envelopes = [
            entry,
            {"calls": [entry]},
            {"calls": entry},
            {"calls": json.dumps([entry])},
            {"calls": [{"name": "mori_image_search", "arguments": json.dumps(entry["arguments"])}]},
        ]
        for envelope in envelopes:
            for raw in (envelope, json.dumps(envelope)):
                with self.subTest(raw=raw), contextlib.redirect_stdout(io.StringIO()):
                    checker.inspect(self.bridge_payload(raw))

    def test_schema_description_is_not_execution(self):
        payload = self.bridge_payload({"names": ["mori_image_search"]}, name="tool_describe")
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            checker.inspect(payload)

    def test_other_tool_and_multi_local_calls_do_not_count(self):
        entry = {"name": "mori_image_search", "arguments": {}}
        for args in (
            {"calls": [entry, entry]},
            {"calls": [{"name": "other", "arguments": entry}]},
            {"calls": [{"name": "mori_image_search", "arguments": "bad json"}]},
            {"calls": "bad json"},
        ):
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                checker.inspect(self.bridge_payload(args))

    def test_bridge_output_requires_same_call_id(self):
        payload = self.bridge_payload({"calls": [{"name": "mori_image_search", "arguments": {}}]})
        payload["output"][1]["call_id"] = "unrelated"
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            checker.inspect(payload)

    def test_failed_bridge_result_never_passes(self):
        payload = self.bridge_payload({"calls": [{"name": "mori_image_search", "arguments": {}}]})
        for result in (
            {"success": False, "data": {"images": [ROW]}},
            {"success": True, "data": {"images": []}},
            {"success": True, "data": None},
        ):
            payload["output"][1]["output"] = json.dumps(result)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                checker.inspect(payload)


if __name__ == "__main__":
    unittest.main()
