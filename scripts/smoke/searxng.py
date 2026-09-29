"""Check the shared SearXNG from its Pod; run on k3s master, no port-forward needed."""

import argparse
import json
import os
import subprocess

REMOTE_CHECK = r"""
import json
import time
import urllib.parse
import urllib.request

params = json.loads(PARAMS_JSON)
base = "http://searxng.search.svc.cluster.local:8080"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(base + "/healthz", timeout=10) as response:
    print("SearXNG health HTTP", response.status, flush=True)
started = time.monotonic()
with opener.open(base + "/search?" + urllib.parse.urlencode(params), timeout=30) as response:
    payload = json.load(response)
results = payload.get("results", [])
if params["categories"] == "images":
    results = [r for r in results if r.get("img_src") and r.get("url")]
else:
    results = [r for r in results if r.get("title") and r.get("url")]
print("검색어:", params["q"])
print("소요:", round(time.monotonic() - started, 2), "초")
print("유효 결과 수:", len(results))
failures = payload.get("unresponsive_engines", [])
print("실패/제한 엔진:", failures)
for result in results[:5]:
    print("-", result.get("title", ""))
    print("  출처:", result.get("url", ""))
    if params["categories"] == "images":
        print("  이미지:", result.get("img_src", ""))
    print("  engines:", result.get("engines", []))
if not results:
    raise SystemExit("FAIL: 유효 검색 결과가 없습니다.")
if failures:
    raise SystemExit("DEGRADED: 결과는 있지만 일부 검색 엔진이 실패했습니다.")
print("PASS: 검색 응답 확인. 본문 추출/이미지 로딩/Hermes 호출은 별도 검증 대상입니다.")
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["web", "images"], default="web")
    parser.add_argument("--engine", choices=["google", "naver"], default="google")
    parser.add_argument("--query")
    args = parser.parse_args()
    params = {
        "q": args.query or ("경복궁 전경" if args.mode == "images" else "국립중앙박물관"),
        "format": "json",
        "language": "ko-KR",
        "categories": "images" if args.mode == "images" else "general",
        "engines": f"{args.engine} images" if args.mode == "images" else "google,naver,brave",
    }
    code = "PARAMS_JSON = " + repr(json.dumps(params, ensure_ascii=False)) + "\n" + REMOTE_CHECK
    cmd = ([] if os.geteuid() == 0 else ["sudo"]) + [
        "k3s",
        "kubectl",
        "-n",
        "search",
        "exec",
        "-i",
        "deployment/searxng",
        "-c",
        "searxng",
        "--",
        "/usr/local/searxng/.venv/bin/python",
        "-",
    ]
    try:
        result = subprocess.run(cmd, input=code, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise SystemExit("FAIL: 검색 검사 시간 초과") from None
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
