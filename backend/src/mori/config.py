from urllib.parse import urlsplit

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
