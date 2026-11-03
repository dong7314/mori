from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from mori.organizer.schemas import Input


class CheckoutComplete(Input):
    customer_key: str = Field(min_length=1, max_length=100)
    auth_key: str = Field(min_length=1, max_length=300)


class CheckoutRead(BaseModel):
    id: UUID
    provider: Literal["toss"]
    client_key: str
    customer_key: str
    amount: int
    currency: Literal["KRW"]
    billing_interval: Literal["month"]
    expires_at: datetime
    success_url: str
    fail_url: str
    order_id: UUID | None


class OrderRead(BaseModel):
    id: UUID
    status: Literal["pending", "processing", "paid", "failed", "canceled", "review"]
    amount: int
    currency: Literal["KRW"]
    created_at: datetime
    error_code: str | None


class WebhookPayment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    orderId: str = Field(max_length=64)


class PaymentWebhook(BaseModel):
    model_config = ConfigDict(extra="ignore")
    eventType: Literal["PAYMENT_STATUS_CHANGED"]
    data: WebhookPayment
