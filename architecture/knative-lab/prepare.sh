#!/usr/bin/env bash
# Download only. Does not connect to or change a Kubernetes cluster.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
version=1.23.0
curl -fL --retry 3 -o serving-crds.yaml "https://github.com/knative/serving/releases/download/knative-v${version}/serving-crds.yaml"
curl -fL --retry 3 -o serving/serving-core.yaml "https://github.com/knative/serving/releases/download/knative-v${version}/serving-core.yaml"
curl -fL --retry 3 -o kourier/kourier.yaml "https://github.com/knative-extensions/net-kourier/releases/download/knative-v${version}/kourier.yaml"
printf '%s\n' 'Downloaded Knative 1.23.0. Follow README.md to render, review and apply.'
