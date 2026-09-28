import re
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MORI_", env_file=".env", extra="ignore", hide_input_in_errors=True
    )

    database_url: SecretStr
    cors_origins: list[str] = []
    auth_public_base_url: str = "http://localhost:8000"
    auth_return_urls: list[str] = ["http://localhost:5173/auth/callback"]
    auth_cookie_secure: bool = True
    auth_access_token_seconds: int = Field(default=900, ge=60, le=3600)
    auth_session_days: int = Field(default=30, ge=1, le=90)
    naver_client_id: str = ""
    naver_client_secret: SecretStr = SecretStr("")
    kakao_client_id: str = ""
    kakao_client_secret: SecretStr = SecretStr("")
    hermes_base_url: str = ""
    hermes_api_key: SecretStr = SecretStr("")
    hermes_test_user_id: UUID | None = None
    hermes_timeout_seconds: int = Field(default=300, ge=10, le=600)
    assistant_test_token_enabled: bool = False
    assistant_test_token: SecretStr = SecretStr("")

    @model_validator(mode="after")
    def require_explicit_test_token(self):
        if self.assistant_test_token_enabled and not re.fullmatch(
            r"mori_lab_[A-Za-z0-9_-]{64}", self.assistant_test_token.get_secret_value()
        ):
            raise ValueError("Generate a test token with scripts/create_assistant_test_token.py")
        return self

    @field_validator("hermes_api_key")
    @classmethod
    def validate_hermes_key(cls, value: SecretStr) -> SecretStr:
        if any(not 33 <= ord(c) <= 126 for c in value.get_secret_value()):
            raise ValueError("Hermes key must contain only visible ASCII characters")
        return value

    @field_validator("hermes_base_url")
    @classmethod
    def validate_hermes_url(cls, value: str) -> str:
        if not value:
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
            or parsed.path not in {"", "/"}
            or "\\" in value
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)
        ):
            raise ValueError("Hermes URL must be an HTTP(S) origin without credentials or paths")
        return value.rstrip("/")

    @field_validator("hermes_test_user_id", mode="before")
    @classmethod
    def empty_test_user(cls, value):
        return None if value == "" else value

    @field_validator("database_url")
    @classmethod
    def require_postgres(cls, value: SecretStr) -> SecretStr:
        if make_url(value.get_secret_value()).drivername != "postgresql+psycopg":
            raise ValueError("MORI_DATABASE_URL must use postgresql+psycopg")
        return value

    @field_validator("cors_origins")
    @classmethod
    def require_explicit_origins(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("Specify individual frontend origins instead of a wildcard")
        return value

    @field_validator("auth_public_base_url")
    @classmethod
    def validate_public_url(cls, value: str) -> str:
        validate_auth_url(value, allow_app_scheme=False)
        if urlsplit(value).path not in {"", "/"}:
            raise ValueError("The public API URL must be an origin without a path prefix")
        return value.rstrip("/")

    @field_validator("auth_return_urls")
    @classmethod
    def validate_return_urls(cls, value: list[str]) -> list[str]:
        for url in value:
            validate_auth_url(url, allow_app_scheme=True)
        return value

    @model_validator(mode="after")
    def secure_cookie_for_public_hosts(self):
        if not self.auth_cookie_secure and urlsplit(self.auth_public_base_url).hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            raise ValueError("OAuth cookies must be Secure outside localhost")
        return self


def validate_auth_url(value: str, *, allow_app_scheme: bool) -> None:
    parsed = urlsplit(value)
    _ = parsed.port  # Reject malformed or out-of-range ports at startup.
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
        or "\\" in value
    ):
        raise ValueError(
            "Auth URLs require a host and must not contain credentials, query or fragment"
        )
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return
    if allow_app_scheme and parsed.scheme == "mori":
        return
    raise ValueError("Use HTTPS, localhost HTTP, or an explicitly allowed mori app callback")
