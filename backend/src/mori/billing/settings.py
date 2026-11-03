from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator


class BillingMarketSettings(BaseModel):
    billing_enabled: bool = False
    billing_toss_secret_key: SecretStr = SecretStr("")
    billing_toss_client_key: str = ""
    billing_encryption_key: SecretStr = SecretStr("")
    billing_pro_amount: int | None = Field(default=None, ge=100, le=10000000)
    billing_success_url: str = ""
    billing_fail_url: str = ""
    billing_lease_seconds: int = Field(default=300, ge=240, le=900)
    kis_enabled: bool = False
    kis_app_key: SecretStr = SecretStr("")
    kis_app_secret: SecretStr = SecretStr("")
    kis_symbols: dict[str, str] = Field(default_factory=lambda: {"AAPL": "NAS"})

    @field_validator("billing_pro_amount", mode="before")
    @classmethod
    def empty_price(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def validate_billing_market(self):
        if self.billing_enabled:
            secret = self.billing_toss_secret_key.get_secret_value()
            if not secret.startswith(("test_sk_", "live_sk_")):
                raise ValueError("Use a Toss API individual-integration secret key")
            if not self.billing_toss_client_key or self.billing_pro_amount is None:
                raise ValueError("Billing requires client key and server-owned price")
            Fernet(self.billing_encryption_key.get_secret_value().encode())
            for value in (self.billing_success_url, self.billing_fail_url):
                parsed = urlsplit(value)
                if (
                    parsed.scheme != "https"
                    or not parsed.hostname
                    or parsed.username
                    or parsed.password
                    or parsed.fragment
                    or parsed.query
                ):
                    raise ValueError("Billing callback must be a fixed HTTPS URL")
        if self.kis_enabled and not (
            self.kis_app_key.get_secret_value() and self.kis_app_secret.get_secret_value()
        ):
            raise ValueError("KIS credentials are required")
        if any(exchange not in {"NAS", "NYS", "AMS"} for exchange in self.kis_symbols.values()):
            raise ValueError("KIS symbol exchange must be NAS, NYS or AMS")
        return self
