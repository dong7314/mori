"""Prepare the FIRST Knative cutover from the live Deployment; never mutate the cluster."""

import copy
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".local/knative"
SERVICE = "mori-hermes-knative"
CLIENT = "mori-hermes-coldstart-client"
FEATURES = (
    "nodeselector",
    "tolerations",
    "init-containers",
    "securitycontext",
    "persistent-volume-claim",
    "persistent-volume-write",
)


def kube_json(*args):
    cmd = ([] if os.geteuid() == 0 else ["sudo"]) + ["k3s", "kubectl", *args, "-o", "json"]
    data = subprocess.check_output(cmd, text=True)
    return json.loads(data) if data.strip() else None


def render(deployment):
    source = deployment["spec"]["template"]["spec"]
    containers = source["containers"]
    if len(containers) != 1 or containers[0]["name"] != "hermes":
        raise ValueError("Expected the single-container Hermes Deployment")
    image = containers[0]["image"]
    if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image):
        raise ValueError("Source Deployment must use an immutable image digest")
    if len(source.get("initContainers", [])) != 1 or source["initContainers"][0]["image"] != image:
        raise ValueError("Expected one init container using the same image")
    volumes = source.get("volumes", [])
    if not any(
        v.get("persistentVolumeClaim", {}).get("claimName") == "mori-hermes-shared-home"
        for v in volumes
    ):
        raise ValueError("Expected the existing Hermes PVC")
    # Drop server-defaulted/disallowed fields; never copy Deployment app labels.
    fields = (
        "containers",
        "initContainers",
        "volumes",
        "nodeSelector",
        "tolerations",
        "securityContext",
        "imagePullSecrets",
        "automountServiceAccountToken",
        "serviceAccountName",
    )
    pod = {key: copy.deepcopy(source[key]) for key in fields if key in source}
    pod["containers"][0]["ports"] = [{"name": "http1", "containerPort": 8642}]
    for name in ("startupProbe", "readinessProbe", "livenessProbe"):
        if name in pod["containers"][0]:
            pod["containers"][0][name]["httpGet"]["port"] = 8642
    pod.update(containerConcurrency=1, timeoutSeconds=300)
    service = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": SERVICE,
            "namespace": "mori",
            "labels": {"networking.knative.dev/visibility": "cluster-local"},
            "annotations": {
                "networking.knative.dev/ingress.class": "kourier.ingress.networking.knative.dev"
            },
        },
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "autoscaling.knative.dev/class": "kpa.autoscaling.knative.dev",
                        "autoscaling.knative.dev/min-scale": "0",
                        "autoscaling.knative.dev/max-scale": "1",
                        "autoscaling.knative.dev/window": "60s",
                        "autoscaling.knative.dev/scale-down-delay": "0s",
                        "autoscaling.knative.dev/scale-to-zero-pod-retention-period": "0s",
                    }
                },
                "spec": pod,
            }
        },
    }
    client = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": CLIENT, "namespace": "mori"},
        "spec": {
            "restartPolicy": "Never",
            "automountServiceAccountToken": False,
            "nodeSelector": copy.deepcopy(source.get("nodeSelector", {})),
            "tolerations": copy.deepcopy(source.get("tolerations", [])),
            "imagePullSecrets": copy.deepcopy(source.get("imagePullSecrets", [])),
            "containers": [
                {
                    "name": "client",
                    "image": image,
                    "imagePullPolicy": "IfNotPresent",
                    "command": ["python", "-c", "import time; time.sleep(86400)"],
                    "securityContext": {
                        "runAsUser": 10000,
                        "runAsGroup": 10000,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "64Mi"},
                        "limits": {"cpu": "250m", "memory": "256Mi"},
                    },
                    "env": [
                        {
                            "name": "API_SERVER_KEY",
                            "valueFrom": {
                                "secretKeyRef": {"name": "mori-hermes", "key": "API_SERVER_KEY"}
                            },
                        }
                    ],
                }
            ],
        },
    }
    return service, client


def main():
    if kube_json("-n", "mori", "get", "ksvc", SERVICE, "--ignore-not-found"):
        raise SystemExit(
            "Knative Service already exists. Do not regenerate/apply a new Revision against the same PVC; follow the maintenance/rollback guide."
        )
    deployment = kube_json("-n", "mori", "get", "deployment", "mori-hermes-shared")
    service, client = render(deployment)
    claim = kube_json("-n", "mori", "get", "pvc", "mori-hermes-shared-home")
    if claim.get("status", {}).get("phase") != "Bound":
        raise SystemExit("Expected the existing Bound PVC")
    OUT.mkdir(parents=True, exist_ok=True)
    objects = {
        "hermes-service.json": service,
        "client.json": client,
        "features-patch.json": {
            "data": {f"kubernetes.podspec-{name}": "enabled" for name in FEATURES}
        },
    }
    for name, obj in objects.items():
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
    print("Prepared .local/knative/{hermes-service,client,features-patch}.json")
    print(
        "No cluster changes. Secret references only. Source image:",
        service["spec"]["template"]["spec"]["containers"][0]["image"],
    )
    print(
        "First cutover only: dry-run, stop source Deployment and wait for all PVC users before apply."
    )


if __name__ == "__main__":
    main()
