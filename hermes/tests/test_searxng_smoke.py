"""Reject image smoke-test false positives using real remote-check code and fake HTTP."""

import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "searxng_smoke", Path(__file__).resolve().parents[2] / "scripts/smoke/searxng.py"
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def row(engine):
    return {
        "title": "photo",
        "url": "https://example.org/page",
        "img_src": "https://example.org/photo.jpg",
        "engines": [engine],
    }


class ImageSmokeTests(unittest.TestCase):
    def run_check(self, rows, failures=None):
        health = io.BytesIO(b"ok")
        health.status = 200
        response = io.BytesIO(
            json.dumps({"results": rows, "unresponsive_engines": failures or []}).encode()
        )
        opener = Mock()
        opener.open.side_effect = [health, response]
        output = io.StringIO()
        with (
            patch("urllib.request.build_opener", return_value=opener),
            contextlib.redirect_stdout(output),
        ):
            exec(
                smoke.REMOTE_CHECK,
                {"PARAMS_JSON": '{"q":"!goi photo"}', "EXPECTED_ENGINE": "google images"},
            )
        return output.getvalue()

    def test_requested_engine_succeeds(self):
        self.assertIn("PASS:", self.run_check([row("google images")]))

    def test_mixed_engines_fail(self):
        with self.assertRaisesRegex(SystemExit, "섞였습니다"):
            self.run_check([row("google images"), row("naver images")])

    def test_wrong_engine_alone_fails(self):
        with self.assertRaises(SystemExit):
            self.run_check([row("naver images")])

    def test_empty_and_degraded_do_not_pass(self):
        with self.assertRaisesRegex(SystemExit, "FAIL"):
            self.run_check([])
        with self.assertRaisesRegex(SystemExit, "DEGRADED"):
            self.run_check([row("google images")], [["google images", "CAPTCHA"]])

    def test_cli_uses_engine_bang_without_category_union(self):
        for engine, bang in (("google", "!goi"), ("naver", "!nvri")):
            with (
                self.subTest(engine=engine),
                patch("sys.argv", ["searxng.py", "--mode", "images", "--engine", engine]),
                patch.object(smoke.subprocess, "run", return_value=Mock(returncode=0)) as run,
            ):
                with self.assertRaises(SystemExit) as result:
                    smoke.main()
                self.assertEqual(result.exception.code, 0)
                namespace = {}
                preamble = run.call_args.kwargs["input"].split(smoke.REMOTE_CHECK)[0]
                exec(preamble, namespace)
                params = json.loads(namespace["PARAMS_JSON"])
                self.assertTrue(params["q"].startswith(bang + " "))
                self.assertNotIn("categories", params)
                self.assertNotIn("engines", params)


if __name__ == "__main__":
    unittest.main()
