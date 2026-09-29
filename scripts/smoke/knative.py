"""Probe the Knative Route from an independent client and check PVC persistence."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER_HASH = ROOT / ".local/knative/marker.sha256"
KUBE = ([] if os.geteuid() == 0 else ["sudo"]) + ["k3s", "kubectl"]
SERVICE = "mori-hermes-knative"
SELECTOR = "serving.knative.dev/service=" + SERVICE
REMOTE = r"""
import os, sys, time, urllib.error
sys.path.insert(0, '/opt/mori/checks')
import runtime
base, mode = sys.argv[1:3]
key = os.environ['API_SERVER_KEY']
started = time.monotonic()
try:
    if mode == 'health':
        result = runtime.http(base + '/v1/toolsets', key, timeout=300)
        enabled = {row.get('name') for row in result.get('data', []) if row.get('enabled') and row.get('configured')}
        if not {'web', 'mori_images'} <= enabled:
            raise ValueError('Expected ready web and image toolsets')
        print('PASS: authenticated Knative Route response')
    else:
        prompts = {
            'search': "web_search로 '서울 관광 공식 사이트'를 실제 검색하고 공식 사이트 3개를 출처 URL과 함께 한국어로 정리해줘.",
            'extract': f'web_extract로 {runtime.URL} 본문을 읽고 관람시간, 휴관일, 적용 연도를 출처와 함께 정리해줘.',
        }
        # No preflight HTTP request: this POST itself must wake the zero-pod runtime.
        response = runtime.http(base + '/v1/responses', key, {'input': prompts[mode], 'store': False, 'stream': False}, 300)
        runtime.verify(response, mode)
    print('요청부터 응답까지:', round(time.monotonic() - started, 2), '초', flush=True)
except urllib.error.HTTPError as exc:
    raise SystemExit(f'FAIL: HTTP {exc.code}; do not immediately retry, upstream work may still be running')
except (TimeoutError, urllib.error.URLError):
    raise SystemExit('FAIL: network/timeout; do not immediately retry, upstream work may still be running')
"""


def get(*args):
    return json.loads(subprocess.check_output(KUBE + [*args, "-o", "json"], text=True))


def live_pods(selector):
    return get("-n", "mori", "get", "pods", "-l", selector)["items"]


def check_source_stopped():
    source = get("-n", "mori", "get", "deployment", "mori-hermes-shared")
    if source["spec"].get("replicas", 1) != 0 or live_pods("app=mori-hermes-shared"):
        raise SystemExit("Stop the original Deployment and wait for its Pods to disappear first")


def check_no_pvc_users():
    check_source_stopped()
    pods = get("-n", "mori", "get", "pods")["items"]
    users = [
        p["metadata"]["name"]
        for p in pods
        if any(
            v.get("persistentVolumeClaim", {}).get("claimName") == "mori-hermes-shared-home"
            for v in p["spec"].get("volumes", [])
        )
    ]
    if users:
        raise SystemExit(
            "PVC still referenced by Pods (including terminating): " + ", ".join(users)
        )
    print("PASS: source replicas=0; no Pod references Hermes PVC")


def marker(action):
    if action == "marker-create":
        selector = "app=mori-hermes-shared"
        if live_pods(SELECTOR):
            raise SystemExit("Cannot initialize marker while Knative Pods exist")
    else:
        selector = SELECTOR
        check_source_stopped()
    pods = live_pods(selector)
    if len(pods) != 1 or pods[0]["metadata"].get("deletionTimestamp"):
        raise SystemExit("Expected exactly one non-terminating Hermes Pod for marker operation")
    code = (
        "from pathlib import Path; import hashlib,uuid; p=Path('/opt/data/.mori-coldstart-probe'); "
    )
    if action == "marker-create":
        code += "\np.write_text(uuid.uuid4().hex) if not p.exists() else None\n"
    code += "\nprint(hashlib.sha256(p.read_bytes()).hexdigest())"
    digest = subprocess.check_output(
        KUBE
        + [
            "-n",
            "mori",
            "exec",
            pods[0]["metadata"]["name"],
            "-c",
            "hermes",
            "--",
            "python",
            "-c",
            code,
        ],
        text=True,
    ).strip()
    if len(digest) != hashlib.sha256().digest_size * 2 or any(
        c not in "0123456789abcdef" for c in digest
    ):
        raise SystemExit("Unexpected marker digest output")
    if action == "marker-create":
        MARKER_HASH.parent.mkdir(parents=True, exist_ok=True)
        if MARKER_HASH.exists() and MARKER_HASH.read_text().strip() != digest:
            raise SystemExit("Existing local marker differs; refusing to overwrite baseline")
        MARKER_HASH.write_text(digest + "\n")
        print("Saved PVC marker hash; no conversation data changed")
    else:
        if not MARKER_HASH.exists() or MARKER_HASH.read_text().strip() != digest:
            raise SystemExit("FAIL: PVC marker does not match original")
        print(
            "PASS: PVC test file preserved. This does not verify conversational memory semantics."
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=["health", "search", "extract", "marker-create", "marker-check", "check-stopped"],
        default="health",
    )
    parser.add_argument("--require-zero", action="store_true")
    args = parser.parse_args()
    if args.mode.startswith("marker-"):
        marker(args.mode)
        return
    if args.mode == "check-stopped":
        check_no_pvc_users()
        return
    check_source_stopped()
    service = get("-n", "mori", "get", "ksvc", SERVICE)
    url = service.get("status", {}).get("url", "")
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != f"{SERVICE}.mori.svc.cluster.local"
        or parsed.port not in (None, 80)
    ):
        raise SystemExit(
            "Unexpected cluster-local Knative URL; inspect ksvc status.url before sending credentials"
        )
    pods = live_pods(SELECTOR)
    if args.require_zero and pods:
        raise SystemExit(
            "Not a cold start: Hermes Pods still exist. Wait for automatic scale-to-zero."
        )
    print("Route:", url, "Pods before request:", len(pods), flush=True)
    print("Waiting up to 300 seconds; this request is not retried automatically.", flush=True)
    result = subprocess.run(
        KUBE
        + [
            "-n",
            "mori",
            "exec",
            "-i",
            "mori-hermes-coldstart-client",
            "-c",
            "client",
            "--",
            "python",
            "-",
            url.rstrip("/"),
            args.mode,
        ],
        input=REMOTE,
        text=True,
    )
    if result.returncode:
        raise SystemExit(result.returncode)
    pods = live_pods(SELECTOR)
    for pod in pods:
        print("Pod after request:", pod["metadata"]["name"])
        print("Created:", pod["metadata"]["creationTimestamp"])
        for condition in pod.get("status", {}).get("conditions", []):
            if condition["type"] == "Ready":
                print("Ready transition:", condition.get("lastTransitionTime"), condition["status"])
    if args.require_zero and not pods:
        raise SystemExit("FAIL: no new Hermes Pod observed after request")


if __name__ == "__main__":
    main()
