"""Local Docker lifecycle check; creates/removes only its own disposable volume/container.

No home-cluster, GPU or external search access. Run against a built linux/amd64 image.
"""

import argparse
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def docker(*args, check=True):
    return subprocess.run(["docker", *args], text=True, capture_output=True, check=check)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    name = "mori-image-check-" + uuid.uuid4().hex[:12]
    volume = name + "-home"
    config = str(ROOT / "infra/k3s/base/hermes/config.yaml")
    docker("volume", "create", volume)
    try:
        for _ in range(2):
            # Same image and mount layout as the Kubernetes init container.
            docker(
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--network",
                "none",
                "--mount",
                f"type=volume,src={volume},dst=/opt/data",
                "--mount",
                f"type=bind,src={config},dst=/bootstrap/config.yaml,readonly",
                "--entrypoint",
                "python",
                args.image,
                "/opt/mori/bootstrap.py",
            )
        docker(
            "run",
            "-d",
            "--name",
            name,
            "--platform",
            "linux/amd64",
            "--network",
            "none",
            "--mount",
            f"type=volume,src={volume},dst=/opt/data",
            "-e",
            "API_SERVER_ENABLED=true",
            "-e",
            "API_SERVER_HOST=0.0.0.0",
            "-e",
            "API_SERVER_PORT=8642",
            "-e",
            "API_SERVER_KEY=local-image-check-only",
            "-e",
            "LLAMA_API_KEY=local-image-check-only",
            "-e",
            "SEARXNG_URL=http://searxng.mori-tools.svc.cluster.local:8080",
            args.image,
        )
        check = None
        for _ in range(45):
            check = docker(
                "exec",
                "--user",
                "10000:10000",
                name,
                "python",
                "/opt/mori/checks/runtime.py",
                "--mode",
                "health",
                check=False,
            )
            if check.returncode == 0:
                print(check.stdout.strip())
                print(
                    "PASS: official entrypoint, PVC init twice, native plugins and auth; no GPU/search requests"
                )
                return
            if docker("inspect", "--format", "{{.State.Running}}", name).stdout.strip() != "true":
                break
            time.sleep(2)
        print(check.stdout if check else "Health check did not run")
        logs = docker("logs", "--tail", "50", name, check=False)
        print(logs.stdout + logs.stderr)
        raise SystemExit("Image lifecycle check failed")
    finally:
        docker("rm", "-f", name, check=False)
        docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    main()
