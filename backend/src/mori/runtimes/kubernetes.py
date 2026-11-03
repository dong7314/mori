"""A small, namespaced Kubernetes client with explicit object ownership checks."""

import base64
import hashlib
import json
import ssl
from pathlib import Path

import httpx

from mori.errors import ApiError

MANAGER = "mori-runtime-provisioner"
SERVICE_API = "/apis/serving.knative.dev/v1/namespaces"
CORE_API = "/api/v1/namespaces"


def failure(code="RUNTIME_CLUSTER_UNAVAILABLE"):
    return ApiError(
        503, code, "개인 에이전트 환경을 준비하지 못했습니다. 잠시 후 다시 확인해 주세요."
    )


def labels(binding):
    return {
        "mori.app/managed-by": MANAGER,
        "mori.app/user-id": str(binding.user_id),
        "mori.app/runtime-id": str(binding.id),
    }


def owns(resource, binding):
    actual = resource.get("metadata", {}).get("labels", {})
    if not isinstance(actual, dict) or any(actual.get(k) != v for k, v in labels(binding).items()):
        raise failure("RUNTIME_RESOURCE_CONFLICT")


def generation(resource):
    value = resource.get("metadata", {}).get("labels", {}).get("mori.app/generation")
    if not isinstance(value, str) or not value.isdecimal():
        raise failure("RUNTIME_RESOURCE_CONFLICT")
    return int(value)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def render(binding, settings, api_key):
    name = binding.resource_name
    scale_down_delay = f"{settings.runtime_scale_down_delay_seconds}s"
    metadata = {"name": name, "namespace": binding.namespace, "labels": labels(binding)}
    versioned = {
        **metadata,
        "labels": {**labels(binding), "mori.app/generation": str(binding.generation)},
    }
    secret = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": versioned,
        "type": "Opaque",
        "immutable": True,
        "data": {"API_SERVER_KEY": base64.b64encode(api_key.encode()).decode()},
    }
    claim = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": metadata,
        "spec": {
            "accessModes": ["ReadWriteOnce"],
            "storageClassName": settings.runtime_storage_class,
            "resources": {"requests": {"storage": settings.runtime_storage_size}},
        },
    }
    config = {
        "gateway": {"multiplex_profiles": False},
        "providers": {
            "mori": {
                "api": settings.runtime_llm_url,
                "key_env": "LLAMA_API_KEY",
                "transport": "chat_completions",
            }
        },
        "model": {
            "provider": "custom:mori",
            "default": settings.runtime_llm_model,
            "context_length": settings.runtime_llm_context_length,
        },
        "web": {
            "search_backend": "searxng",
            "extract_backend": "mori-local",
            "extract_timeout": 90,
            "keyless_fallback": False,
            "keyless_rescue": False,
        },
        "plugins": {"enabled": ["mori_images", "mori_extract", "mori_documents"]},
        "platform_toolsets": {"api_server": ["web", "mori_images"]},
    }
    config_map = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": versioned,
        "immutable": True,
        "data": {"config.yaml": json.dumps(config, ensure_ascii=False)},
    }
    container = {
        "name": "hermes",
        "image": settings.runtime_image,
        "imagePullPolicy": "IfNotPresent",
        "args": ["gateway", "run"],
        "ports": [{"name": "http1", "containerPort": 8642}],
        "env": [
            {"name": "API_SERVER_ENABLED", "value": "true"},
            {"name": "API_SERVER_HOST", "value": "0.0.0.0"},
            {"name": "API_SERVER_PORT", "value": "8642"},
            {"name": "SEARXNG_URL", "value": settings.runtime_searxng_url},
            {
                "name": "API_SERVER_KEY",
                "valueFrom": {"secretKeyRef": {"name": name, "key": "API_SERVER_KEY"}},
            },
            {
                "name": "LLAMA_API_KEY",
                "valueFrom": {
                    "secretKeyRef": {
                        "name": settings.runtime_provider_secret,
                        "key": "LLAMA_API_KEY",
                    }
                },
            },
        ],
        # The pinned image's stage2 bootstrap starts as root then drops the gateway
        # to uid 10000. Pinning runAsUser or dropping SETUID/SETGID breaks that contract.
        "securityContext": {"allowPrivilegeEscalation": False},
        "resources": {
            "requests": {"cpu": "250m", "memory": "512Mi"},
            "limits": {"cpu": "2", "memory": "4Gi"},
        },
        "readinessProbe": {
            "httpGet": {"path": "/health", "port": 8642},
            "periodSeconds": 5,
            "timeoutSeconds": 3,
        },
        "startupProbe": {
            "httpGet": {"path": "/health", "port": 8642},
            "periodSeconds": 5,
            "timeoutSeconds": 3,
            "failureThreshold": 60,
        },
        "livenessProbe": {
            "httpGet": {"path": "/health", "port": 8642},
            "periodSeconds": 20,
            "timeoutSeconds": 5,
            "failureThreshold": 3,
        },
        "volumeMounts": [{"name": "home", "mountPath": "/opt/data"}],
    }
    service = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            **versioned,
            "labels": {**versioned["labels"], "networking.knative.dev/visibility": "cluster-local"},
            "annotations": {"networking.knative.dev/ingress.class": settings.runtime_ingress_class},
        },
        "spec": {
            "template": {
                "metadata": {
                    "labels": versioned["labels"],
                    "annotations": {
                        "autoscaling.knative.dev/class": "kpa.autoscaling.knative.dev",
                        "autoscaling.knative.dev/min-scale": "0",
                        "autoscaling.knative.dev/max-scale": "1",
                        "autoscaling.knative.dev/scale-down-delay": scale_down_delay,
                    },
                },
                "spec": {
                    "containerConcurrency": 1,
                    "timeoutSeconds": 600,
                    "automountServiceAccountToken": False,
                    "serviceAccountName": settings.runtime_service_account,
                    "securityContext": {"fsGroup": 10000},
                    "nodeSelector": settings.runtime_node_selector,
                    "tolerations": settings.runtime_tolerations,
                    "imagePullSecrets": [{"name": n} for n in settings.runtime_image_pull_secrets],
                    "containers": [container],
                    "initContainers": [
                        {
                            "name": "initialize-home",
                            "image": settings.runtime_image,
                            "command": ["python", "/opt/mori/bootstrap.py"],
                            "resources": {
                                "requests": {"cpu": "50m", "memory": "64Mi"},
                                "limits": {"cpu": "1", "memory": "256Mi"},
                            },
                            "volumeMounts": [
                                {"name": "home", "mountPath": "/opt/data"},
                                {"name": "config", "mountPath": "/bootstrap", "readOnly": True},
                            ],
                        }
                    ],
                    "volumes": [
                        {"name": "home", "persistentVolumeClaim": {"claimName": name}},
                        {"name": "config", "configMap": {"name": name}},
                    ],
                },
            }
        },
    }
    # A changed operator image/config must use a deliberate stop-before-recreate upgrade.
    # Updating a live Knative Revision against the same RWO home can cause concurrent writers.
    service["metadata"]["annotations"]["mori.app/spec-hash"] = digest(service["spec"])
    return secret, claim, config_map, service


class Kubernetes:
    def __init__(self, settings, transport=None):
        self.settings = settings
        if transport is None:
            context = ssl.create_default_context(cafile=settings.runtime_kubernetes_ca_file)
        else:
            context = True
        self.client = httpx.AsyncClient(
            base_url=settings.runtime_kubernetes_url,
            transport=transport,
            verify=context,
            timeout=settings.runtime_request_timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        )
        self.testing = transport is not None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.client.aclose()

    async def request(self, method, path, *, missing=False, **kwargs):
        # Re-read projected token on each request so Kubernetes token rotation is respected.
        token = (
            "test-token"
            if self.testing
            else Path(self.settings.runtime_kubernetes_token_file).read_text().strip()
        )
        if not token or any(c.isspace() for c in token):
            raise failure("RUNTIME_CLUSTER_CREDENTIALS")
        try:
            async with self.client.stream(
                method, path, headers={"Authorization": f"Bearer {token}"}, **kwargs
            ) as response:
                if missing and response.status_code == 404:
                    return None
                if response.status_code == 409:
                    raise failure("RUNTIME_CLUSTER_CONFLICT")
                if response.status_code not in {200, 201, 202}:
                    raise failure(
                        "RUNTIME_CLUSTER_FORBIDDEN"
                        if response.status_code in {401, 403}
                        else "RUNTIME_CLUSTER_UNAVAILABLE"
                    )
                content = bytearray()
                async for part in response.aiter_bytes():
                    content.extend(part)
                    if len(content) > 2_000_000:
                        raise failure("RUNTIME_CLUSTER_RESPONSE")
                body = json.loads(content)
                if not isinstance(body, dict):
                    raise ValueError("Object expected")
                return body
        except (httpx.HTTPError, ValueError, UnicodeError) as exc:
            raise failure() from exc

    @staticmethod
    def path(binding, kind):
        root = SERVICE_API if kind == "services" else CORE_API
        return f"{root}/{binding.namespace}/{kind}/{binding.resource_name}"

    async def get(self, binding, kind):
        value = await self.request("GET", self.path(binding, kind), missing=True)
        if value is not None:
            owns(value, binding)
        return value

    async def ensure(self, binding, kind, payload):
        current = await self.get(binding, kind)
        if current is None:
            try:
                current = await self.request(
                    "POST", self.path(binding, kind).rsplit("/", 1)[0], json=payload
                )
            except ApiError as exc:
                if exc.code != "RUNTIME_CLUSTER_CONFLICT":
                    raise
                current = await self.get(binding, kind)
                if current is None:
                    raise
        owns(current, binding)
        if kind != "persistentvolumeclaims" and generation(current) != binding.generation:
            raise failure("RUNTIME_GENERATION_CHANGED")
        if current.get("metadata", {}).get("deletionTimestamp"):
            raise failure("RUNTIME_TERMINATING")
        if kind in {"secrets", "configmaps"}:
            if current.get("data") != payload["data"] or current.get("immutable") is not True:
                raise failure("RUNTIME_CONFIGURATION_CHANGED")
        elif kind == "services":
            old = current.get("metadata", {}).get("annotations", {}).get("mori.app/spec-hash")
            if old != payload["metadata"]["annotations"]["mori.app/spec-hash"]:
                raise failure("RUNTIME_CONFIGURATION_CHANGED")
        return current

    async def delete(self, binding, kind):
        current = await self.get(binding, kind)
        if current is None:
            return
        if generation(current) > binding.generation:
            raise failure("RUNTIME_GENERATION_CHANGED")
        uid = current.get("metadata", {}).get("uid")
        if not uid:
            raise failure("RUNTIME_CLUSTER_RESPONSE")
        await self.request(
            "DELETE",
            self.path(binding, kind),
            missing=True,
            json={
                "apiVersion": "v1",
                "kind": "DeleteOptions",
                "propagationPolicy": "Foreground",
                "preconditions": {"uid": uid},
            },
        )

    async def pods(self, binding):
        selector = ",".join(f"{k}={v}" for k, v in labels(binding).items())
        result = await self.request(
            "GET",
            f"{CORE_API}/{binding.namespace}/pods",
            params={"labelSelector": selector, "limit": 2},
        )
        if not isinstance(result.get("items"), list):
            raise failure("RUNTIME_CLUSTER_RESPONSE")
        return result["items"]
