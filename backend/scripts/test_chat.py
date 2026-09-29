"""Headless authenticated SSE client. Does not bypass login or retry writes."""

import argparse
import getpass
import json
import os
from uuid import UUID, uuid4

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--conversation", type=UUID)
    parser.add_argument("--request-key", type=UUID, default=None)
    parser.add_argument("--message", required=True)
    args = parser.parse_args()
    token = os.environ.get("MORI_ACCESS_TOKEN") or getpass.getpass("Mori access token: ")
    key = args.request_key or uuid4()
    with httpx.Client(
        base_url=args.base_url.rstrip("/"),
        headers={"Authorization": "Bearer " + token},
        timeout=660,
        trust_env=False,
        follow_redirects=False,
    ) as client:
        cid = args.conversation
        if cid is None:
            response = client.post("/v1/conversations", json={"title": "주차 API 검증"})
            response.raise_for_status()
            cid = response.json()["id"]
        print("Conversation:", cid)
        print("Idempotency-Key:", key)
        terminal = None
        with client.stream(
            "POST",
            f"/v1/conversations/{cid}/messages",
            headers={"Idempotency-Key": str(key)},
            json={"message": args.message},
        ) as response:
            response.raise_for_status()
            run_id = response.headers.get("x-mori-run-id")
            print("Run:", run_id)
            data = []
            for line in response.iter_lines():
                if line.startswith("data:"):
                    data.append(line[5:].lstrip())
                elif not line and data:
                    event = json.loads("\n".join(data))
                    data = []
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                    if event["type"] in ("run.completed", "run.failed", "run.interrupted"):
                        terminal = event["type"]
        if run_id:
            response = client.get(f"/v1/conversations/{cid}/runs/{run_id}")
            response.raise_for_status()
            print("저장된 실행 상태:", response.json()["status"])
        if terminal != "run.completed":
            raise SystemExit(
                "완료되지 않았습니다. 출력된 실행 ID로 확인하세요. 자동 재시도하지 않습니다."
            )


if __name__ == "__main__":
    main()
