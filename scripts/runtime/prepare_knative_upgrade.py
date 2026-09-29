"""Render a stop-before-replace Knative upgrade. Reads metadata, never applies changes."""

import argparse
import copy
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / ".local/knative"
SERVICE = "mori-hermes-knative"


def render(current, image):
    if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image):
        raise ValueError("Use the new Harbor image digest, not a mutable tag")
    if current["metadata"]["name"] != SERVICE or current["metadata"]["namespace"] != "mori":
        raise ValueError("Expected the Mori Knative lab service")
    service = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {"name": SERVICE, "namespace": "mori"},
        "spec": copy.deepcopy(current["spec"]),
    }
    for field in ("labels", "annotations"):
        service["metadata"][field] = {
            k: v
            for k, v in current["metadata"].get(field, {}).items()
            if not k.startswith("kubectl.kubernetes.io/")
        }
    template = service["spec"]["template"]
    template["metadata"] = {
        k: v for k, v in template.get("metadata", {}).items() if k in ("labels", "annotations")
    }
    pod = template["spec"]
    if len(pod["containers"]) != 1 or pod["containers"][0]["name"] != "hermes":
        raise ValueError("Expected a single Hermes user container")
    if (
        len(pod.get("initContainers", [])) != 1
        or pod["initContainers"][0]["name"] != "initialize-home"
    ):
        raise ValueError("Expected initialize-home")
    if not any(
        v.get("persistentVolumeClaim", {}).get("claimName") == "mori-hermes-shared-home"
        for v in pod.get("volumes", [])
    ):
        raise ValueError("Expected the existing Hermes PVC")
    container = pod["containers"][0]
    container["image"] = image
    container.pop("command", None)  # Remove the temporary /bin/sh foreground override.
    container["args"] = ["gateway", "run"]
    pod["initContainers"][0]["image"] = image
    # A recreated service must not route to a deleted old Revision.
    service["spec"]["traffic"] = [{"latestRevision": True, "percent": 100}]
    patch = {
        "spec": {
            "template": {
                "spec": {
                    "containers": [
                        {
                            "name": "hermes",
                            "image": image,
                            "command": None,
                            "args": ["gateway", "run"],
                        }
                    ],
                    "initContainers": [{"name": "initialize-home", "image": image}],
                }
            }
        }
    }
    return service, patch


def main():
    from prepare_knative import kube_json

    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Verified Mori 0.1.1+ image@sha256 digest")
    args = parser.parse_args()
    source = kube_json("-n", "mori", "get", "deployment", "mori-hermes-shared")
    if source["spec"].get("replicas", 1) != 0:
        raise SystemExit("Original Deployment must stay at replicas=0")
    current = kube_json("-n", "mori", "get", "ksvc", SERVICE)
    service, patch = render(current, args.image)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, value in (
        ("hermes-service-upgrade.json", service),
        ("deployment-image-patch.json", patch),
    ):
        (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print("Prepared .local/knative/{hermes-service-upgrade,deployment-image-patch}.json")
    print("No cluster changes. FIRST delete the old Knative service, then run check-stopped.")
    print("Only after it passes: patch the stopped Deployment and apply the new service.")


if __name__ == "__main__":
    main()
