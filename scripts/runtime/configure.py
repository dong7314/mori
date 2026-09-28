"""Write standalone Kubernetes YAML from tracked sources; never contact the cluster."""

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra/k3s/base"
DEFAULT_OUTPUT = ROOT / ".local/manifests"
IMAGE_PLACEHOLDER = "image: mori-hermes:dev"
PULL_SECRETS_PLACEHOLDER = "imagePullSecrets: []"


def _config_map(name, namespace, key, source):
    lines = source.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"Empty ConfigMap source: {source}")
    data = "\n".join("    " + line for line in lines)
    return (
        "apiVersion: v1\n"
        "kind: ConfigMap\n"
        "metadata:\n"
        f"  name: {name}\n"
        f"  namespace: {namespace}\n"
        "data:\n"
        f"  {key}: |\n{data}\n"
    )


def _source(component, filename):
    return (INFRA / component / filename).read_text(encoding="utf-8")


def render_manifests(image, pull_secret=None):
    """Return two directly applicable YAML files, with no secret values."""
    match = re.fullmatch(r"([a-zA-Z0-9][a-zA-Z0-9._:/-]*)@sha256:([0-9a-f]{64})", image)
    if not match or "/" not in match[1] or ":" in match[1].rsplit("/", 1)[-1]:
        raise ValueError("Use a registry image with digest: HARBOR/PROJECT/mori-hermes@sha256:...")
    if pull_secret and not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?", pull_secret):
        raise ValueError("Invalid Kubernetes image pull secret name")

    hermes = _source("hermes", "deployment.yaml")
    if hermes.count(IMAGE_PLACEHOLDER) != 2:
        raise ValueError("Expected one Hermes init and one main image placeholder")
    if hermes.count(PULL_SECRETS_PLACEHOLDER) != 1:
        raise ValueError("Expected one Hermes image pull secret placeholder")
    hermes = hermes.replace(IMAGE_PLACEHOLDER, f"image: {image}")
    pull_secrets = (
        f"imagePullSecrets: [{{name: {pull_secret}}}]" if pull_secret else PULL_SECRETS_PLACEHOLDER
    )
    hermes = hermes.replace(PULL_SECRETS_PLACEHOLDER, pull_secrets)

    manifests = {
        "hermes.yaml": [
            _config_map("mori-hermes-config", "mori", "config.yaml", INFRA / "hermes/config.yaml"),
            hermes,
            _source("hermes", "service.yaml"),
        ],
        "searxng.yaml": [
            _config_map(
                "searxng-config", "mori-tools", "settings.yml", INFRA / "searxng/settings.yml"
            ),
            _source("searxng", "deployment.yaml"),
            _source("searxng", "service.yaml"),
        ],
    }
    return {
        name: "\n---\n".join(part.rstrip() for part in parts) + "\n"
        for name, parts in manifests.items()
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Immutable Harbor image@sha256:digest")
    parser.add_argument("--pull-secret", help="Existing image pull Secret in namespace mori")
    args = parser.parse_args()
    try:
        manifests = render_manifests(args.image, args.pull_secret)
    except ValueError as exc:
        parser.error(str(exc))
    DEFAULT_OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, content in manifests.items():
        (DEFAULT_OUTPUT / name).write_text(content, encoding="utf-8")
    print("Prepared .local/manifests/{hermes,searxng}.yaml (no cluster changes)")


if __name__ == "__main__":
    main()
