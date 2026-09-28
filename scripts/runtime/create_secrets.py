"""Run on the k3s master after namespaces.yaml; prompt for keys without printing them."""

import argparse
import base64
import getpass
import json
import os
import secrets
import subprocess

KUBECTL = ([] if os.geteuid() == 0 else ["sudo"]) + ["k3s", "kubectl"]


def kube(args, body=None):
    process = subprocess.run(KUBECTL + args, input=body, text=True, capture_output=True)
    if process.returncode:
        # A failed admission webhook may echo the request body, so do not print stderr.
        raise RuntimeError(
            "kubectl operation failed; check cluster access/resource names (secret details omitted)"
        )
    return process.stdout


def ensure_secret(namespace, name, required, factory, secret_type="Opaque"):
    raw = kube(["-n", namespace, "get", "secret", name, "--ignore-not-found", "-o", "json"])
    if raw.strip():
        obj = json.loads(raw)
        if obj.get("type") != secret_type or not all(
            obj.get("data", {}).get(key) for key in required
        ):
            raise ValueError(f"Existing {namespace}/{name} has unexpected type or missing keys")
        print(f"Reused {namespace}/{name}; no key rotation")
        return
    obj = {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": secret_type,
        "metadata": {"name": name, "namespace": namespace},
        "stringData": factory(),
    }
    kube(["create", "-f", "-"], json.dumps(obj))
    print(f"Created {namespace}/{name}; values not printed")


def hermes_keys():
    key = getpass.getpass("Existing GPU llama.cpp API key: ").strip()
    if not key:
        raise ValueError("GPU API key must not be empty")
    return {"LLAMA_API_KEY": key, "API_SERVER_KEY": secrets.token_urlsafe(48)}


def registry_keys(registry):
    username = input("Harbor pull-only robot username: ").strip()
    password = getpass.getpass("Harbor robot secret: ")
    if not username or not password:
        raise ValueError("Registry credentials must not be empty")
    auth = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {".dockerconfigjson": json.dumps({"auths": {registry: {"auth": auth}}})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--registry", help="Optional private Harbor host[:port], without scheme/path"
    )
    args = parser.parse_args()
    if args.registry and ("/" in args.registry or any(c.isspace() for c in args.registry)):
        parser.error("Registry must be host[:port], without scheme/path")
    ensure_secret("mori", "mori-hermes", ["API_SERVER_KEY", "LLAMA_API_KEY"], hermes_keys)
    ensure_secret(
        "mori-tools",
        "searxng-secret",
        ["SEARXNG_SECRET"],
        lambda: {"SEARXNG_SECRET": secrets.token_hex(32)},
    )
    if args.registry:
        ensure_secret(
            "mori",
            "harbor-pull",
            [".dockerconfigjson"],
            lambda: registry_keys(args.registry),
            "kubernetes.io/dockerconfigjson",
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as exc:
        raise SystemExit(str(exc))
