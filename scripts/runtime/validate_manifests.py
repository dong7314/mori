"""Offline Kustomize integration check, including generated registry overlay."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import yaml
from configure import ROOT, configuration


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubectl", default="kubectl")
    args = parser.parse_args()
    scratch = ROOT / ".local"
    scratch.mkdir(exist_ok=True)
    image = "registry.example/mori/hermes@sha256:" + "a" * 64
    with tempfile.TemporaryDirectory(dir=scratch) as temp:
        (Path(temp) / "kustomization.yaml").write_text(
            json.dumps(configuration(image, "harbor-pull"))
        )
        rendered = subprocess.check_output([args.kubectl, "kustomize", temp], text=True)
    objects = list(yaml.safe_load_all(rendered))
    assert len(objects) == 6
    assert not any(o["kind"] in ("Secret", "PersistentVolumeClaim", "Namespace") for o in objects)
    configs = {
        (o["metadata"]["namespace"], o["metadata"]["name"]): o
        for o in objects
        if o["kind"] == "ConfigMap"
    }
    for obj in objects:
        if obj["kind"] != "Deployment":
            continue
        ns = obj["metadata"]["namespace"]
        pod = obj["spec"]["template"]["spec"]
        assert obj["spec"]["strategy"]["type"] == "Recreate"
        assert pod["nodeSelector"] == {
            "kubernetes.io/hostname": "k3s-infra",
            "kubernetes.io/arch": "amd64",
        }
        assert pod["automountServiceAccountToken"] is False
        for volume in pod["volumes"]:
            if "configMap" in volume:
                assert (ns, volume["configMap"]["name"]) in configs, (
                    "Broken generated ConfigMap reference"
                )
        if ns == "mori":
            assert pod["imagePullSecrets"] == [{"name": "harbor-pull"}]
            assert pod["containers"][0]["image"] == image
            assert pod["initContainers"][0]["image"] == image
            cm = next(
                configs[(ns, v["configMap"]["name"])] for v in pod["volumes"] if "configMap" in v
            )
            cfg = yaml.safe_load(cm["data"]["config.yaml"])
            assert cfg["gateway"]["multiplex_profiles"] is False
            assert cfg["web"]["extract_backend"] == "mori-local"
            assert cfg["platform_toolsets"]["api_server"] == ["web", "mori_images"]
        else:
            assert ns == "mori-tools"
            assert all("@sha256:" in c["image"] for c in pod["containers"] + pod["initContainers"])
            cm = next(
                configs[(ns, v["configMap"]["name"])] for v in pod["volumes"] if "configMap" in v
            )
            cfg = yaml.safe_load(cm["data"]["settings.yml"])
            assert set(cfg["use_default_settings"]["engines"]["keep_only"]) == {
                "google",
                "naver",
                "brave",
                "google images",
                "naver images",
            }
            assert "json" in cfg["search"]["formats"]
    print(
        "PASS: both namespaces, hashed config references, immutable images, init/main image match, separate storage/secrets"
    )


if __name__ == "__main__":
    main()
