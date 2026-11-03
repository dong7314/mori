from datetime import datetime
from typing import Literal

from pydantic import Field

from mori.organizer.schemas import Input, Title


class ProfileUpdate(Input):
    display_name: Title
    revision: int = Field(ge=1)


class SettingsWrite(Input):
    theme: Literal["system", "light", "dark"]
    revision: int = Field(ge=0)


class SettingsRead(SettingsWrite):
    pass


class PlanRead(Input):
    id: Literal["free", "pro"]
    name: str
    description: str
    amount: int | None
    currency: Literal["KRW"] = "KRW"
    billing_interval: Literal["month", "year"] | None = None
    checkout_available: bool = False
    status: Literal["available", "coming_soon"]


class SubscriptionRead(Input):
    plan: Literal["free", "pro"]
    access_source: Literal["free", "admin_approval", "paid_subscription"]
    billing_status: Literal[
        "not_subscribed", "pending", "active", "past_due", "canceled", "failed", "review"
    ] = "not_subscribed"
    cancel_at_period_end: bool = False
    current_period_end: datetime | None = None
    revision: int = 0
    amount: int | None = None
    checkout_available: bool = False
    cancellation_available: bool = False
    message: str
