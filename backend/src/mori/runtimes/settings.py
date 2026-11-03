"""Operator-owned runtime settings; none are accepted from user request bodies."""

import re
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings

DNS_LABEL = r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?"


class RuntimeSettings(BaseSettings):
    runtime_provisioning_enabled: bool = False
    runtime_namespace: str = "mori-agents"
    runtime_image: str = ""
    runtime_master_key: SecretStr = SecretStr("")
    runtime_kubernetes_url: str = "https://kubernetes.default.svc"
    runtime_kubernetes_token_file: str = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    runtime_kubernetes_ca_file: str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    runtime_storage_class: str = "local-path"
    runtime_storage_size: str = "5Gi"
    runtime_provider_secret: str = "mori-hermes-provider"
    runtime_service_account: str = "mori-hermes"
    runtime_image_pull_secrets: list[str] = Field(default_factory=list)
    runtime_llm_url: str = ""
    runtime_llm_model: str = ""
    runtime_llm_context_length: int = Field(default=98304, ge=4096, le=1_000_000)
    runtime_searxng_url: str = "http://searxng.search.svc.cluster.local:8080"
    runtime_node_selector: dict[str, str] = Field(
        default_factory=lambda: {"kubernetes.io/arch": "amd64"}
    )
    runtime_tolerations: list[dict] = Field(default_factory=list)
    runtime_poll_seconds: int = Field(default=10, ge=1, le=60)
    runtime_lease_seconds: int = Field(default=180, ge=120, le=600)
    runtime_request_timeout_seconds: int = Field(default=10, ge=1, le=15)
    runtime_scale_down_delay_seconds: int = Field(default=120, ge=0, le=600)
    runtime_ingress_class: str = "kourier.ingress.networking.knative.dev"

    @field_validator("runtime_namespace", "runtime_provider_secret", "runtime_service_account")
    @classmethod
    def valid_name(cls, value):
        if len(value) > 63 or not re.fullmatch(DNS_LABEL, value):
            raise ValueError("Use a Kubernetes DNS label")
        return value

    @field_validator("runtime_image_pull_secrets")
    @classmethod
    def valid_secret_names(cls, value):
        if len(value) > 10 or len(set(value)) != len(value):
            raise ValueError("Use distinct image pull Secret names")
        return [cls.valid_name(name) for name in value]

    @field_validator("runtime_storage_size")
    @classmethod
    def valid_size(cls, value):
        if not re.fullmatch(r"[1-9][0-9]{0,3}(Mi|Gi)", value):
            raise ValueError("Use a positive Mi or Gi storage quantity")
        return value

    @field_validator("runtime_kubernetes_url", "runtime_llm_url", "runtime_searxng_url")
    @classmethod
    def valid_url(cls, value, info):
        if not value and info.field_name == "runtime_llm_url":
            return value
        parsed = urlsplit(value)
        _ = parsed.port
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or "\\" in value
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)
        ):
            raise ValueError("Use a trusted HTTP(S) URL without credentials")
        if info.field_name == "runtime_kubernetes_url" and (
            parsed.scheme != "https" or parsed.path not in {"", "/"}
        ):
            raise ValueError("Kubernetes API must be an HTTPS origin")
        return value.rstrip("/")

    @model_validator(mode="after")
    def valid_runtime_configuration(self):
        key = self.runtime_master_key.get_secret_value()
        if key:
            try:
                Fernet(key.encode("ascii"))
            except (ValueError, UnicodeError) as exc:
                raise ValueError("Runtime master key must be a Fernet key") from exc
        if self.runtime_provisioning_enabled:
            if not key or not re.fullmatch(r".+@sha256:[0-9a-f]{64}", self.runtime_image):
                raise ValueError("Provisioning requires an encryption key and pinned runtime image")
            if not self.runtime_llm_url or not self.runtime_llm_model:
                raise ValueError("Provisioning requires the trusted model endpoint and model name")
        return self
