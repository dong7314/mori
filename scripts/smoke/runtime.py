"""Master CLI: run versioned checks in the ready Hermes image; no port-forward needed."""

import argparse
import json
import os
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=(
            "health",
            "search-direct",
            "images-direct",
            "search",
            "images",
            "extract",
            "search-extract",
        ),
        default="health",
    )
    parser.add_argument("--engine", choices=("google", "naver"), default="google")
    args = parser.parse_args()
    kube = ([] if os.geteuid() == 0 else ["sudo"]) + ["k3s", "kubectl"]
    data = json.loads(
        subprocess.check_output(
            kube + ["-n", "mori", "get", "pods", "-l", "app=mori-hermes-shared", "-o", "json"],
            text=True,
        )
    )
    ready = [
        p
        for p in data["items"]
        if not p["metadata"].get("deletionTimestamp")
        and any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in p.get("status", {}).get("conditions", [])
        )
    ]
    if len(ready) != 1:
        raise SystemExit(f"Expected exactly one Ready Hermes Pod; found {len(ready)}")
    name = ready[0]["metadata"]["name"]
    print("Executing in:", name, flush=True)
    raise SystemExit(
        subprocess.call(
            kube
            + [
                "-n",
                "mori",
                "exec",
                name,
                "-c",
                "hermes",
                "--",
                "python",
                "/opt/mori/checks/runtime.py",
                "--mode",
                args.mode,
                "--engine",
                args.engine,
            ]
        )
    )


if __name__ == "__main__":
    main()
