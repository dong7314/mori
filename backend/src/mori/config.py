from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MORI_", env_file=".env", extra="ignore")

    database_url: SecretStr
    cors_origins: list[str] = []

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
