"""Bounded HTTP HTML fetch + Trafilatura. No JS/browser, cookies or API keys."""

import http.client
import ipaddress
import json
import socket
import ssl
import sys
from urllib.parse import quote, urljoin, urlsplit

MAX_BYTES = 2_000_000
MAX_TEXT = 100_000


def resolve_public(url):
    if (
        not isinstance(url, str)
        or len(url) > 4096
        or any(ord(c) < 32 or ord(c) == 127 for c in url)
    ):
        raise ValueError("Invalid URL")
    p = urlsplit(url)
    if (
        p.scheme not in ("http", "https")
        or not p.hostname
        or p.username is not None
        or p.password is not None
    ):
        raise ValueError("Only HTTP(S) URLs without credentials are supported")
    host = p.hostname.encode("idna").decode("ascii")
    port = p.port or (443 if p.scheme == "https" else 80)
    if port != (443 if p.scheme == "https" else 80):
        raise ValueError("Only standard HTTP(S) ports are supported")
    addresses = [v[4][0] for v in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise ValueError("Private, local or reserved network addresses are blocked")
    path = quote(p.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if p.query:
        path += "?" + quote(p.query, safe="/%?:@!$&'()*+,;=-._~")
    return p.scheme, host, port, addresses[0], path


class PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, address):
        super().__init__(host, port, timeout=8)
        self.address = address

    def connect(self):
        # Connect to the validated address; don't resolve the hostname a second time.
        self.sock = socket.create_connection((self.address, self.port), timeout=self.timeout)


class PinnedHTTPS(PinnedHTTP):
    def connect(self):
        super().connect()
        try:
            self.sock = ssl.create_default_context().wrap_socket(
                self.sock, server_hostname=self.host
            )
        except Exception:
            self.close()
            raise


def fetch_html(url):
    current = url
    for redirect in range(4):
        scheme, host, port, address, path = resolve_public(current)
        conn = (PinnedHTTPS if scheme == "https" else PinnedHTTP)(host, port, address)
        try:
            conn.request(
                "GET",
                path,
                headers={
                    "User-Agent": "Mori-Extract/0.1",
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                },
            )
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                target = response.getheader("Location")
                if not target or redirect == 3:
                    raise ValueError("Invalid or excessive redirects")
                current = urljoin(current, target)
                if scheme == "https" and urlsplit(current).scheme != "https":
                    raise ValueError("HTTPS downgrade redirect blocked")
                continue
            if response.status != 200:
                raise ValueError(f"Page returned HTTP {response.status}")
            mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if mime not in ("text/html", "application/xhtml+xml"):
                raise ValueError("This provider supports HTML only (no PDF/image/JSON)")
            if response.getheader("Content-Encoding", "identity").lower() not in ("", "identity"):
                raise ValueError("Unexpected compressed response")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("HTML exceeds 2 MB")
            return body, current
        finally:
            conn.close()
    raise ValueError("Redirect limit exceeded")


def extract_page(url, format=None):
    from trafilatura import extract
    from trafilatura.metadata import extract_metadata

    html, final_url = fetch_html(url)
    meta = extract_metadata(html, default_url=final_url)
    title = (meta.title if meta else "") or ""
    if any(s in title.lower() for s in ("access denied", "captcha", "just a moment", "접근 차단")):
        raise ValueError("Page appears to be an access challenge")
    content = extract(
        html,
        url=final_url,
        output_format="txt" if format == "text" else "markdown",
        include_comments=False,
        include_tables=True,
        favor_recall=True,
    )
    if not content or len(content.strip()) < 200:
        raise ValueError(
            "No substantial HTML text extracted; JS rendering or access checks may be required"
        )
    if len(content) > MAX_TEXT:
        raise ValueError("Extracted text exceeds 100000 characters")
    # Keep requested url as identity so Hermes cache and call-output matching are correct.
    # The factual accuracy of extracted text is not certified by a successful HTTP fetch.
    return {
        "url": url,
        "title": title,
        "content": content,
        "metadata": {"sourceURL": url, "finalURL": final_url, "provider": "mori-local"},
    }


if __name__ == "__main__":
    url = ""
    try:
        request = json.load(sys.stdin)
        url = request["url"]
        result = extract_page(url, request.get("format"))
    except Exception as exc:
        result = {"url": url, "content": "", "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False))
