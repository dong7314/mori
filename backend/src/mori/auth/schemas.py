from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, SecretStr, StringConstraints


class Provider(StrEnum):
    NAVER = "naver"
    KAKAO = "kakao"


Challenge = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{43}$")]
ClientState = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{32,128}$")]
Verifier = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._~-]{43,128}$")]
LoginCode = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{43}$")]


class ExchangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: LoginCode
    code_verifier: Verifier


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: SecretStr


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
    refresh_token: str
    refresh_expires_in: int


class MeResponse(BaseModel):
    id: UUID
    display_name: str
    providers: list[Provider]


class ProviderAvailability(BaseModel):
    provider: Provider
    enabled: bool
