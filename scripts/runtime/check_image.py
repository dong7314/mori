"""Offline Docker lifecycle regression: same volume, TERM/KILL, auth and persistence.

Only disposable containers/volume are used; no cluster, GPU or search requests.
"""

import argparse
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFY_PROCESS = r"""
import json
from pathlib import Path
assert b'dumb-init' in Path('/proc/1/cmdline').read_bytes(), 'Missing real init'
state = json.loads(Path('/opt/data/gateway_state.json').read_text())
pid = state['pid']
assert pid != 1
status = Path(f'/proc/{pid}/status').read_text()
assert status.split('Uid:')[1].splitlines()[0].split() == ['10000'] * 4
processes = []
for p in Path('/proc').iterdir():
    if not p.name.isdigit():
        continue
    try:
        argv = (p / 'cmdline').read_bytes().split(bytes([0]))
    except OSError:
        continue
    if b'/opt/hermes/.venv/bin/hermes' in argv and b'gateway' in argv and b'run' in argv:
        processes.append(int(p.name))
assert processes == [pid], f'Expected one gateway: {processes}'
p = Path('/opt/data/.mori-lifecycle-marker')
assert p.read_text() == 'keep-me', 'Volume marker was lost'
print('PASS: real init, one unprivileged gateway, retained volume marker')
"""


def docker(*args, check=True):
    return subprocess.run(["docker", *args], text=True, capture_output=True, check=check)


def wait_healthy(name):
    for _ in range(90):
        probe = docker(
            "exec",
            name,
            "python",
            "-c",
            "import urllib.request; "
            "urllib.request.build_opener(urllib.request.ProxyHandler({})).open("
            "'http://127.0.0.1:8642/health', timeout=2).close()",
            check=False,
        )
        if probe.returncode == 0:
            result = docker(
                "exec",
                "--user",
                "10000:10000",
                name,
                "python",
                "/opt/mori/checks/runtime.py",
                "--mode",
                "health",
            )
            print(result.stdout.strip(), flush=True)
            return
        if docker("inspect", "--format", "{{.State.Running}}", name).stdout.strip() != "true":
            break
        time.sleep(2)
    raise RuntimeError("Gateway did not become healthy")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument(
        "--documents", action="store_true", help="Enable and verify document toolset"
    )
    args = parser.parse_args()
    name = "mori-image-check-" + uuid.uuid4().hex[:12]
    volume = name + "-home"
    scratch = ROOT / ".local"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mori-image-config-", dir=scratch) as temporary:
        config_path = Path(temporary) / "config.yaml"
        content = (ROOT / "infra/k3s/base/hermes/config.yaml").read_text()
        if args.documents:
            content = content.replace(
                "    - web\n    - mori_images\n",
                "    - web\n    - mori_images\n    - mori_documents\n",
            )
        config_path.write_text(content)
        mounts = ["--mount", f"type=volume,src={volume},dst=/opt/data"]
        common = ["--platform", "linux/amd64", "--network", "none", *mounts]
        environment = []
        for value in (
            "API_SERVER_ENABLED=true",
            "API_SERVER_HOST=0.0.0.0",
            "API_SERVER_PORT=8642",
            "API_SERVER_KEY=local-image-check-only",
            "LLAMA_API_KEY=local-image-check-only",
            "SEARXNG_URL=http://searxng.search.svc.cluster.local:8080",
        ):
            environment.extend(["-e", value])
        docker("volume", "create", volume)
        try:
            for _ in range(2):
                docker(
                    "run",
                    "--rm",
                    *common,
                    "--mount",
                    f"type=bind,src={config_path},dst=/bootstrap/config.yaml,readonly",
                    "--entrypoint",
                    "python",
                    args.image,
                    "/opt/mori/bootstrap.py",
                )
            docker(
                "run",
                "--rm",
                *common,
                "--user",
                "10000:10000",
                "--entrypoint",
                "python",
                args.image,
                "-c",
                "from pathlib import Path; "
                "Path('/opt/data/.mori-lifecycle-marker').write_text('keep-me')",
            )
            for cycle in range(3):
                print(f"Gateway boot {cycle + 1}/3 (same volume)", flush=True)
                docker("run", "-d", "--name", name, *common, *environment, args.image)
                wait_healthy(name)
                print(
                    docker("exec", name, "python", "-c", VERIFY_PROCESS).stdout.strip(), flush=True
                )
                if args.documents and cycle == 0:
                    result = docker(
                        "exec",
                        "--user",
                        "10000:10000",
                        name,
                        "python",
                        "/opt/mori/checks/documents.py",
                        "--require-toolset",
                    )
                    print(result.stdout.strip(), flush=True)
                if cycle == 1:
                    docker("kill", "--signal", "KILL", name)
                    expected = 137
                else:
                    docker("stop", "--signal", "SIGTERM", "--time", "60", name)
                    expected = 0
                code = int(docker("inspect", "--format", "{{.State.ExitCode}}", name).stdout)
                if code != expected:
                    raise RuntimeError(f"Exit code {code}; expected {expected}")
                print(f"PASS: {'KILL' if cycle == 1 else 'TERM'} exit={code}", flush=True)
                docker("rm", name)
            # A real child failure must survive both our entrypoint and init, not become success.
            failure = docker(
                "run",
                "--rm",
                *common,
                *environment,
                args.image,
                "python",
                "-c",
                "raise SystemExit(23)",
                check=False,
            )
            if failure.returncode != 23:
                raise RuntimeError(f"Failure exit was changed: {failure.returncode}")
            print("PASS: failure exit=23 preserved; lifecycle regression complete", flush=True)
        except BaseException:
            logs = docker("logs", "--tail", "80", name, check=False)
            print(logs.stdout + logs.stderr, flush=True)
            raise
        finally:
            docker("rm", "-f", name, check=False)
            docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    main()
