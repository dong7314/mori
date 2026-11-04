"""Mock network tests. Optional HTML fixture uses the installed Trafilatura 2.2.0."""

import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "checks"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


w = load("extract_worker", ROOT / "plugins/mori_extract/worker.py")
c = load("extract_checker", ROOT / "checks/runtime.py")
c.inspect = lambda payload, require_search=False: c.verify(
    payload, "search-extract" if require_search else "extract"
)


def dns(address):
    return [(2, 1, 6, "", (address, 443))]


class Tests(unittest.TestCase):
    def test_public_url_preserves_encoded_query(self):
        with patch.object(w.socket, "getaddrinfo", return_value=dns("8.8.8.8")):
            parts = w.resolve_public("https://example.org/a%20b?q=%ED%95%9C")
        self.assertEqual(parts[-1], "/a%20b?q=%ED%95%9C")
        self.assertEqual(parts[3], "8.8.8.8")

    def test_private_and_reserved_dns_blocked(self):
        for address in (
            "127.0.0.1",
            "192.168.0.8",
            "10.43.0.1",
            "169.254.169.254",
            "::1",
            "fc00::1",
        ):
            with (
                self.subTest(address=address),
                patch.object(w.socket, "getaddrinfo", return_value=dns(address)),
            ):
                with self.assertRaises(ValueError):
                    w.resolve_public("https://example.org")

    def test_mixed_dns_is_rejected(self):
        with patch.object(w.socket, "getaddrinfo", return_value=dns("8.8.8.8") + dns("127.0.0.1")):
            with self.assertRaises(ValueError):
                w.resolve_public("https://example.org")

    def test_credentials_schemes_ports_and_controls_rejected(self):
        for url in (
            "file:///etc/passwd",
            "https://user:pass@example.org/",
            "http://example.org:10250/",
            "https://example.org/\nX: a",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                w.resolve_public(url)

    def test_socket_connect_uses_validated_ip(self):
        with patch.object(w.socket, "create_connection") as connect:
            w.PinnedHTTP("example.org", 80, "8.8.8.8").connect()
            self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 80))

    def fetch_mock(self, response, resolver=None):
        class Conn:
            def __init__(self, *args):
                pass

            def request(self, *args, **kw):
                pass

            def getresponse(self):
                return response

            def close(self):
                pass

        if resolver is None:

            def resolver(url):
                return ("https", "example.org", 443, "8.8.8.8", "/")

        with (
            patch.object(w, "resolve_public", side_effect=resolver),
            patch.object(w, "PinnedHTTPS", Conn),
        ):
            return w.fetch_html("https://example.org")

    def test_redirect_revalidates_destination(self):
        class Response:
            status = 302

            def getheader(self, key):
                return "https://127.0.0.1/"

        def resolver(url):
            if url != "https://example.org":
                raise ValueError("blocked redirect")
            return ("https", "example.org", 443, "8.8.8.8", "/")

        with self.assertRaisesRegex(ValueError, "blocked redirect"):
            self.fetch_mock(Response(), resolver)

    def test_non_html_and_oversized_responses_fail(self):
        class Response:
            status = 200
            mime = "application/pdf"

            def getheader(self, key, default=""):
                return self.mime if key == "Content-Type" else default

            def read(self, size):
                return b"x" * size

        with self.assertRaisesRegex(ValueError, "HTML only"):
            self.fetch_mock(Response())
        r = Response()
        r.mime = "text/html"
        with self.assertRaisesRegex(ValueError, "2 MB"):
            self.fetch_mock(r)

    def test_real_parser_fixture(self):
        if importlib.util.find_spec("trafilatura") is None:
            self.skipTest("Trafilatura absent in this Python")
        paragraph = "관람시간은 요일마다 다릅니다. 입장 마감과 휴관일 및 휴실일을 확인하세요. 전시실 안내를 확인한 뒤 방문하세요. "
        html = (
            "<html><head><title>테스트 박물관 관람 안내</title></head><body><main><article>"
            "<h1>관람 안내</h1>"
            + "".join("<p>" + str(i) + "번 전시실 안내: " + paragraph + "</p>" for i in range(8))
            + "</article></main></body></html>"
        ).encode()
        with patch.object(w, "fetch_html", return_value=(html, c.URL)):
            result = w.extract_page(c.URL)
        self.assertIn("관람시간", result["content"])
        self.assertEqual(result["url"], c.URL)

    def payload(self, bridge=False):
        text = "관람시간 입장 마감 휴관일 휴실일 안내. " + "본문 검증용 문장입니다. " * 25

        def call(name, args, cid):
            return {
                "type": "function_call",
                "call_id": cid,
                "name": "tool_call" if bridge else name,
                "arguments": json.dumps(
                    {"calls": [{"name": name, "arguments": args}]} if bridge else args
                ),
            }

        return {
            "status": "completed",
            "output": [
                call("web_search", {"query": "박물관"}, "s"),
                {
                    "type": "function_call_output",
                    "call_id": "s",
                    "output": json.dumps({"success": True, "data": {"web": [{"url": c.URL}]}}),
                },
                call("web_extract", {"urls": [c.URL]}, "e"),
                {
                    "type": "function_call_output",
                    "call_id": "e",
                    "output": json.dumps({"results": [{"url": c.URL, "content": text}]}),
                },
                {"type": "message", "content": [{"type": "output_text", "text": "출처 " + c.URL}]},
            ],
        }

    def test_direct_and_bridge_search_extract_evidence(self):
        with contextlib.redirect_stdout(io.StringIO()):
            c.inspect(self.payload(), True)
            c.inspect(self.payload(True), True)

    def test_reverse_order_not_search_extract_pass(self):
        p = self.payload(True)
        p["output"] = p["output"][2:4] + p["output"][:2] + p["output"][4:]
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            c.inspect(p, True)

    def test_wrong_call_id_fails(self):
        p = self.payload()
        p["output"][3]["call_id"] = "different"
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            c.inspect(p)

    def test_describe_or_failed_result_not_execution_success(self):
        for describe in (True, False):
            p = self.payload()
            if describe:
                p["output"][2]["name"] = "tool_describe"
            else:
                p["output"][3]["output"] = json.dumps(
                    {"results": [{"url": c.URL, "error": "HTTP 403"}]}
                )
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                c.inspect(p)


if __name__ == "__main__":
    unittest.main()
