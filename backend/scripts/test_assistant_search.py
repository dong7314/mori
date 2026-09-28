"""Master-node API smoke test using a temporary lab token or social-login token."""

import argparse
import getpass
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from uuid import UUID

BASE = "http://127.0.0.1:8000"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-token-file", type=Path)
    parser.add_argument("--check-disabled", action="store_true")
    args = parser.parse_args()
    if args.check_disabled and not args.test_token_file:
        parser.error("--check-disabled requires --test-token-file")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(path, token=None, payload=None, timeout=15):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(
            BASE + path,
            headers=headers,
            data=json.dumps(payload).encode() if payload is not None else None,
        )
        try:
            with opener.open(req, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    payload = {
        "message": (
            "국립중앙박물관 공식 관람 안내를 검색하고 본문을 읽어서 "
            "관람시간, 입장 마감, 휴관일을 출처와 함께 알려줘."
        )
    }
    status, _ = request("/v1/assistant/search", payload=payload)
    if status != 401:
        raise ValueError(f"Unauthenticated request: expected 401, got {status}")
    if args.test_token_file:
        token = args.test_token_file.read_text().strip()
        if not re.fullmatch(r"mori_lab_[A-Za-z0-9_-]{64}", token):
            raise ValueError(
                "Invalid lab token file; regenerate with create_assistant_test_token.py"
            )
    else:
        token = getpass.getpass("소셜 로그인으로 받은 Mori access_token (숨김 입력): ").strip()
    if not token:
        raise ValueError("Mori token required")
    if args.check_disabled:
        status, _ = request("/v1/assistant/search", token=token, payload=payload)
        if status != 401:
            raise ValueError(f"Disabled token: expected 401, got {status}")
        print("PASS: 임시 토큰 비활성화 확인 (HTTP 401)")
        return
    if args.test_token_file:
        wrong = token[:-1] + ("A" if token[-1] != "A" else "B")
        status, _ = request("/v1/assistant/search", token=wrong, payload=payload)
        if status != 401:
            raise ValueError(f"Wrong test token: expected 401, got {status}")
    else:
        status, _ = request("/v1/me", token=token)
        if status != 200:
            raise ValueError(f"Mori authentication failed: HTTP {status}")
    print("Mori API에 검색 요청을 보냅니다. 모델 추론을 기다립니다...", flush=True)
    status, data = request("/v1/assistant/search", token=token, payload=payload, timeout=620)
    if status != 200:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        raise ValueError(f"Search failed: HTTP {status}")
    UUID(data["request_id"])
    if (
        not data.get("answer")
        or not data.get("sources")
        or not any(
            t.get("name") == "web_search"
            and t.get("status") == "succeeded"
            and t.get("result_count", 0) > 0
            for t in data.get("tools", [])
        )
    ):
        raise ValueError("Missing search evidence")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    mode = "임시 토큰" if args.test_token_file else "Mori 로그인"
    print(f"PASS: {mode} → Mori API → Hermes 검색 → 답변·출처 반환 확인")
    if not any(s.get("evidence") == "extract" for s in data["sources"]):
        print("주의: 본문 추출 성공은 관측되지 않았습니다. tools 결과를 확인하세요.")
    print("내용의 정확성·사용자별 기억 격리·대화 저장·취소는 이 검사 범위가 아닙니다.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.exit("FAIL: " + str(exc))
