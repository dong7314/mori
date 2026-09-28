"""Generate a local Kustomize overlay with an immutable Harbor image; no cluster writes."""

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def configuration(image, pull_secret=None):
    match = re.fullmatch(r"([a-zA-Z0-9][a-zA-Z0-9._:/-]*)@sha256:([0-9a-f]{64})", image)
    if not match or "/" not in match[1]:
        raise ValueError("Use a registry image with digest: HARBOR/PROJECT/mori-hermes@sha256:...")
    repository = match[1]
    if ":" in repository.rsplit("/", 1)[-1]:
        raise ValueError("Use repository@sha256:digest without a tag")
    result = {
        "apiVersion": "kustomize.config.k8s.io/v1beta1",
        "kind": "Kustomization",
        "resources": ["../../infra/k3s/overlays/home-dev"],
        "images": [{"name": "mori-hermes", "newName": repository, "digest": "sha256:" + match[2]}],
    }
    if pull_secret:
        if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?", pull_secret):
            raise ValueError("Invalid Kubernetes image pull secret name")
        result["patches"] = [
            {
                "target": {"kind": "Deployment", "name": "mori-hermes-shared"},
                "patch": json.dumps(
                    [
                        {
                            "op": "add",
                            "path": "/spec/template/spec/imagePullSecrets",
                            "value": [{"name": pull_secret}],
                        }
                    ]
                ),
            }
        ]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--pull-secret", help="Existing Secret in namespace mori")
    args = parser.parse_args()
    try:
        config = configuration(args.image, args.pull_secret)
    except ValueError as exc:
        parser.error(str(exc))
    destination = ROOT / ".local/runtime"
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "kustomization.yaml").write_text(json.dumps(config, indent=2) + "\n")
    print("Prepared .local/runtime/kustomization.yaml (no cluster changes)")
