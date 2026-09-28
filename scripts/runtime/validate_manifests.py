"""Offline checks for standalone Hermes and SearXNG Kubernetes manifests."""

import argparse
from pathlib import Path

import yaml
from configure import INFRA, ROOT, render_manifests


def validate(image, pull_secret):
    manifests = render_manifests(image, pull_secret)
    objects = [obj for content in manifests.values() for obj in yaml.safe_load_all(content)]
    assert len(objects) == 6
    assert all(obj["kind"] in {"ConfigMap", "Deployment", "Service"} for obj in objects)
    indexed = {
        (obj["kind"], obj["metadata"]["namespace"], obj["metadata"]["name"]): obj for obj in objects
    }
    assert len(indexed) == len(objects)
    assert set(indexed) == {
        ("ConfigMap", "mori", "mori-hermes-config"),
        ("Deployment", "mori", "mori-hermes-shared"),
        ("Service", "mori", "mori-hermes-shared"),
        ("ConfigMap", "mori-tools", "searxng-config"),
        ("Deployment", "mori-tools", "searxng"),
        ("Service", "mori-tools", "searxng"),
    }

    for component, ns, deployment_name, config_name, key in (
        ("hermes", "mori", "mori-hermes-shared", "mori-hermes-config", "config.yaml"),
        ("searxng", "mori-tools", "searxng", "searxng-config", "settings.yml"),
    ):
        config = indexed["ConfigMap", ns, config_name]
        assert config["data"][key] == (INFRA / component / key).read_text(encoding="utf-8")
        deployment = indexed["Deployment", ns, deployment_name]
        service = indexed["Service", ns, deployment_name]
        pod = deployment["spec"]["template"]["spec"]
        labels = deployment["spec"]["template"]["metadata"]["labels"]
        assert deployment["spec"]["strategy"]["type"] == "Recreate"
        assert deployment["spec"]["replicas"] == 1
        assert deployment["spec"]["selector"]["matchLabels"] == labels
        assert service["spec"]["selector"] == labels
        assert service["spec"]["type"] == "ClusterIP"
        assert pod["nodeSelector"] == {
            "kubernetes.io/hostname": "k3s-infra",
            "kubernetes.io/arch": "amd64",
        }
        assert {
            "key": "infra",
            "operator": "Equal",
            "value": "true",
            "effect": "NoSchedule",
        } in pod["tolerations"]
        assert pod["automountServiceAccountToken"] is False
        assert any(v.get("configMap", {}).get("name") == config_name for v in pod["volumes"])
        for port in service["spec"]["ports"]:
            assert any(
                port["targetPort"] == p["name"] for c in pod["containers"] for p in c["ports"]
            )

    hermes_config = yaml.safe_load(
        indexed["ConfigMap", "mori", "mori-hermes-config"]["data"]["config.yaml"]
    )
    assert hermes_config["gateway"]["multiplex_profiles"] is False
    assert hermes_config["web"]["extract_backend"] == "mori-local"
    assert hermes_config["platform_toolsets"]["api_server"] == ["web", "mori_images"]
    searxng_config = yaml.safe_load(
        indexed["ConfigMap", "mori-tools", "searxng-config"]["data"]["settings.yml"]
    )
    assert set(searxng_config["use_default_settings"]["engines"]["keep_only"]) == {
        "google",
        "naver",
        "brave",
        "google images",
        "naver images",
    }
    assert "json" in searxng_config["search"]["formats"]

    hermes = indexed["Deployment", "mori", "mori-hermes-shared"]["spec"]["template"]["spec"]
    assert hermes["imagePullSecrets"] == ([{"name": pull_secret}] if pull_secret else [])
    assert {c["image"] for c in hermes["containers"] + hermes["initContainers"]} == {image}
    assert any(
        v.get("persistentVolumeClaim", {}).get("claimName") == "mori-hermes-shared-home"
        for v in hermes["volumes"]
    )
    searxng = indexed["Deployment", "mori-tools", "searxng"]["spec"]["template"]["spec"]
    assert all("@sha256:" in c["image"] for c in searxng["containers"] + searxng["initContainers"])
    hermes_refs = {
        env["valueFrom"]["secretKeyRef"]["name"]
        for env in hermes["containers"][0]["env"]
        if "valueFrom" in env and "secretKeyRef" in env["valueFrom"]
    }
    assert hermes_refs == {"mori-hermes"}
    searxng_refs = {
        env["valueFrom"]["secretKeyRef"]["name"]
        for env in searxng["containers"][0]["env"]
        if "valueFrom" in env and "secretKeyRef" in env["valueFrom"]
    }
    assert searxng_refs == {"searxng-secret"}

    namespaces = list(
        yaml.safe_load_all((ROOT / "infra/k3s/namespaces.yaml").read_text(encoding="utf-8"))
    )
    assert {obj["metadata"]["name"] for obj in namespaces} == {"mori", "mori-tools"}
    claim = yaml.safe_load(
        (ROOT / "infra/k3s/storage/hermes-home.yaml").read_text(encoding="utf-8")
    )
    assert claim["kind"] == "PersistentVolumeClaim"
    assert claim["metadata"]["namespace"] == "mori"
    assert claim["metadata"]["name"] == "mori-hermes-shared-home"
    return manifests


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="registry.example/mori/hermes@sha256:" + "a" * 64)
    parser.add_argument("--pull-secret")
    parser.add_argument(
        "--output-dir", type=Path, help="Also compare generated files byte-for-byte"
    )
    args = parser.parse_args()
    expected = validate(args.image, args.pull_secret)
    if not args.output_dir:
        validate(args.image, "harbor-pull")
    if args.output_dir:
        for name, content in expected.items():
            assert (args.output_dir / name).read_text(encoding="utf-8") == content
    print(
        "PASS: standalone YAML, namespaces, config/secret/PVC references, placement, immutable images"
    )
