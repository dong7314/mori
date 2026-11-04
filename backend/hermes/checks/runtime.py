"""Run inside the installed Hermes container. Report evidence, never API keys."""

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

from evidence import invocation, result_object

URL = "https://www.museum.go.kr/MUSEUM/contents/M0101000000.do"
MAX_BODY = 4_000_000
MODES = (
    "health",
    "search-direct",
    "images-direct",
    "search",
    "images",
    "extract",
    "search-extract",
)


def http(url, key=None, body=None, timeout=30):
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(
        url, headers=headers, data=None if body is None else json.dumps(body).encode()
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError("Response exceeds 4 MB")
    return json.loads(raw)


def verify(payload, mode):
    if payload.get("status") != "completed" or payload.get("error"):
        raise ValueError("Hermes request did not complete")
    items = payload.get("output", [])
    calls, outputs, passed = {}, set(), []
    messages = [
        item
        for item in items
        if item.get("type") == "message"
        and item.get("role", "assistant") == "assistant"
        and item.get("phase") != "commentary"
    ]
    final = "\n".join(
        c.get("text", "")
        for c in (messages[-1].get("content", []) if messages else [])
        if c.get("type") == "output_text"
    )
    if not final.strip():
        raise ValueError("Missing final answer")
    for index, item in enumerate(items):
        call = invocation(item)
        if call:
            cid = item["call_id"]
            if cid in calls:
                raise ValueError("Duplicate call_id")
            calls[cid] = (index, call)
        if item.get("type") != "function_call_output":
            continue
        cid = item.get("call_id")
        if cid not in calls:
            continue
        if cid in outputs:
            raise ValueError("Duplicate tool output")
        outputs.add(cid)
        _, call = calls[cid]
        result = result_object(item.get("output"))
        if result.get("error") or result.get("success") is False:
            continue
        name = call["name"]
        valid = []
        data = result.get("data") or {}
        if name == "web_search" and result.get("success") is True:
            valid = [
                r
                for r in data.get("web", [])
                if isinstance(r, dict)
                and isinstance(r.get("url"), str)
                and r["url"].startswith(("http://", "https://"))
            ]
            if mode == "search-extract":
                valid = [r for r in valid if r["url"] == URL]
            if not any(r["url"] in final for r in valid):
                valid = []
        elif name == "mori_image_search" and result.get("success") is True:
            valid = [
                r
                for r in data.get("images", [])
                if isinstance(r, dict)
                and all(
                    isinstance(r.get(k), str)
                    and r[k].startswith(("http://", "https://"))
                    and r[k] in final
                    for k in ("image_url", "source_url")
                )
            ]
        elif name == "web_extract" and URL in call["arguments"].get("urls", []):
            valid = [
                r
                for r in result.get("results", [])
                if isinstance(r, dict)
                and r.get("url") == URL
                and not r.get("error")
                and isinstance(r.get("content"), str)
                and len(r["content"].strip()) >= 200
                and URL in final
            ]
        if valid:
            passed.append((name, index, calls[cid][0], len(valid)))
            print(f"Verified {call['via']} -> {name}: {len(valid)} results")
    required = {
        "search": {"web_search"},
        "images": {"mori_image_search"},
        "extract": {"web_extract"},
        "search-extract": {"web_search", "web_extract"},
    }[mode]
    if not required.issubset({p[0] for p in passed}):
        raise ValueError("Required tool call, successful result or final source link missing")
    if mode == "search-extract" and not any(
        search[1] < extract[2]
        for search in passed
        for extract in passed
        if search[0] == "web_search" and extract[0] == "web_extract"
    ):
        raise ValueError("Extraction must be requested after the search result")
    print("\nModel answer:\n" + final)
    print(
        "PASS: tool execution and source evidence; factual accuracy/image loading require separate review"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=MODES, default="health")
    parser.add_argument("--engine", choices=("google", "naver"), default="google")
    args = parser.parse_args()
    base = "http://127.0.0.1:8642"
    key = os.environ["API_SERVER_KEY"]
    if args.mode == "search-direct":
        query = urllib.parse.urlencode(
            {"q": "국립중앙박물관", "format": "json", "categories": "general"}
        )
        data = http(os.environ["SEARXNG_URL"].rstrip("/") + "/search?" + query)
        rows = [
            r
            for r in data.get("results", [])
            if isinstance(r, dict) and r.get("url") and r.get("title")
        ]
        print("Results:", len(rows), "unresponsive engines:", data.get("unresponsive_engines", []))
        for row in rows[:5]:
            print(row["title"], row["url"], row.get("engines"))
        if not rows:
            raise ValueError("No valid search results")
        print("PASS: Pod -> SearXNG JSON search; model invocation not tested")
        return
    if args.mode == "images-direct":
        spec = importlib.util.spec_from_file_location(
            "mori_images", "/opt/mori/plugins/mori_images/__init__.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = json.loads(
            module.search({"query": "경복궁 전경", "engine": args.engine, "limit": 3})
        )
        print(json.dumps(data, ensure_ascii=False, indent=2))
        if not data.get("success") or not data.get("data", {}).get("images"):
            raise ValueError("No valid image candidates")
        print("PASS: image metadata only; model invocation and image loading not tested")
        return
    http(base + "/health")
    toolsets = http(base + "/v1/toolsets", key).get("data", [])
    for name in ("web", "mori_images"):
        if not any(
            t.get("name") == name and t.get("enabled") and t.get("configured") for t in toolsets
        ):
            raise ValueError(f"Toolset not ready: {name}")
    if args.mode == "health":
        for token in (None, "mori-intentionally-wrong-key"):
            try:
                http(base + "/v1/toolsets", token)
            except urllib.error.HTTPError as exc:
                if exc.code == 401:
                    continue
                raise
            raise ValueError("Unauthenticated/wrong-key API request was accepted")
        from tools import web_tools
        from tools.web_tools_extract import _resolve_extract_provider

        web_tools._ensure_web_plugins_loaded()
        backend = web_tools._get_extract_backend()
        provider, error = _resolve_extract_provider(backend)
        if backend != "mori-local" or error or provider is None:
            raise ValueError("Local extraction provider not ready")
        print("PASS: health, authenticated toolsets, 401 checks, mori-local provider readiness")
        return
    prompts = {
        "search": "web_search로 '서울 관광 공식 사이트'를 실제 검색하고 공식 사이트 3개를 출처 URL과 함께 한국어로 정리해줘.",
        "images": f"mori_image_search로 '경복궁 전경'을 engine='{args.engine}', limit=3으로 검색하고 각 후보의 제목, image_url, source_url을 그대로 보여줘. 사진은 미검증이라고 밝혀줘.",
        "extract": f"web_extract로 {URL} 본문을 실제 읽고 관람시간, 휴관일, 적용 연도와 예외를 출처 URL과 함께 정리해줘.",
        "search-extract": f"먼저 web_search로 'site:www.museum.go.kr 국립중앙박물관 관람시간'을 검색하고 결과의 {URL}을 web_extract로 읽어줘. 본문의 관람시간, 휴관일, 적용 연도와 예외를 출처 URL과 함께 정리해줘.",
    }
    prompt = (
        prompts[args.mode]
        + " 필요하면 tool_describe와 tool_call을 사용해. 본문에 없는 정보는 추측하지 마."
    )
    print(
        "Waiting for model/tools (up to 300 seconds); do not immediately retry a timeout.",
        flush=True,
    )
    verify(
        http(base + "/v1/responses", key, {"input": prompt, "store": False, "stream": False}, 300),
        args.mode,
    )


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        sys.exit(f"FAIL: HTTP {exc.code}")
    except (TimeoutError, urllib.error.URLError):
        sys.exit("FAIL: network/timeout; an upstream job may still be running")
    except Exception as exc:
        sys.exit(f"FAIL: {type(exc).__name__}: {exc}")
