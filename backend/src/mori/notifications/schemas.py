import base64
import binascii
import re
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import BaseModel, ConfigDict, Field, field_validator


def decode_key(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value):
        raise ValueError("Use a base64url key")
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid base64url key") from exc


def validate_public_key(value):
    raw = decode_key(value)
    if len(raw) != 65 or raw[0] != 4:
        raise ValueError("Use an uncompressed P-256 public key")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    return value


def validate_endpoint(value):
    parsed = urlsplit(value)
    if (
        not value.isascii()
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
        or "\\" in value
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not parsed.path
    ):
        raise ValueError("Use an HTTPS push endpoint without credentials or nonstandard ports")
    return value


class PushKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: str = Field(max_length=120)
    auth: str = Field(max_length=32)

    _public_key = field_validator("p256dh")(validate_public_key)

    @field_validator("auth")
    @classmethod
    def auth_secret(cls, value):
        if len(decode_key(value)) != 16:
            raise ValueError("Push auth must contain 16 bytes")
        return value


class SubscriptionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=1, max_length=2048)
    keys: PushKeys
    device_name: str = Field(default="", max_length=80)

    _endpoint = field_validator("endpoint")(validate_endpoint)


class SubscriptionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    device_name: str
    active: bool
    created_at: datetime
    updated_at: datetime


class PushConfigRead(BaseModel):
    enabled: bool
    public_key: str | None
    delivery_semantics: Literal["provider_accepted"] = "provider_accepted"


class DeliveryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    reminder_id: UUID
    subscription_id: UUID
    target_at: datetime
    status: Literal["queued", "processing", "retry", "sent", "failed", "skipped"]
    attempts: int
    next_attempt_at: datetime
    last_error_code: str | None
    provider_status: int | None
    sent_at: datetime | None
    created_at: datetime
    updated_at: datetime
