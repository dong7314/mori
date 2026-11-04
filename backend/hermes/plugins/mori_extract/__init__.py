"""Register an extract provider; preserve Hermes' built-in web_extract wrapper."""

import json
import subprocess
from pathlib import Path

from agent.web_search_provider import WebSearchProvider

PYTHON = Path("/opt/mori/extract-venv/bin/python")
WORKER = Path(__file__).with_name("worker.py")


class MoriExtractProvider(WebSearchProvider):
    @property
    def name(self):
        return "mori-local"

    @property
    def display_name(self):
        return "Mori local HTML extraction"

    def is_available(self):
        return PYTHON.is_file() and WORKER.is_file()

    def supports_search(self):
        return False

    def supports_extract(self):
        return True

    def extract(self, urls, **kwargs):
        if not isinstance(urls, list) or len(urls) > 3:
            raise ValueError("Request at most 3 URLs per web_extract call")
        results = []
        for url in urls:
            try:
                p = subprocess.run(
                    [str(PYTHON), str(WORKER)],
                    input=json.dumps({"url": url, "format": kwargs.get("format")}),
                    text=True,
                    encoding="utf-8",
                    capture_output=True,
                    timeout=25,
                )
                if p.returncode:
                    raise ValueError("Extraction worker failed; verify the Trafilatura environment")
                row = json.loads(p.stdout)
                if not isinstance(row, dict) or row.get("url") != url:
                    raise ValueError("Invalid extraction worker response")
                results.append(row)
            except subprocess.TimeoutExpired:
                results.append(
                    {
                        "url": url,
                        "content": "",
                        "error": "Local extraction timed out after 25 seconds",
                    }
                )
            except Exception as exc:
                results.append({"url": url, "content": "", "error": str(exc)})
        return results


def register(ctx):
    ctx.register_web_search_provider(MoriExtractProvider())
