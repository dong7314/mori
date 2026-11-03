"""Toss endpoints are fixed; never trust a client/webhook payment status or amount."""

import asyncio
import base64
import json
from urllib.parse import quote

import httpx

from mori.errors import ApiError

ORIGIN = "https://api.tosspayments.com"


class TossClient:
    def __init__(self, settings, transport=None):
        token = base64.b64encode(
            (settings.billing_toss_secret_key.get_secret_value() + ":").encode()
        ).decode()
        self.headers = {"Authorization": "Basic " + token}
        self.transport = transport

    async def request(self, method, path, *, body=None, key=None, missing=False):
        headers = dict(self.headers)
        if key:
            headers["Idempotency-Key"] = str(key)
        try:
            async with (
                asyncio.timeout(75),
                httpx.AsyncClient(
                    transport=self.transport,
                    trust_env=False,
                    follow_redirects=False,
                    timeout=httpx.Timeout(70, connect=5),
                ) as client,
            ):
                async with client.stream(
                    method, ORIGIN + path, headers=headers, json=body
                ) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 262144:
                            raise ValueError("Oversized payment response")
                    if missing and response.status_code == 404:
                        return None
                    if response.status_code in {408, 409, 429, 500, 502, 503, 504}:
                        raise ApiError(
                            503, "BILLING_PROVIDER_UNAVAILABLE", "결제 상태를 확인 중입니다."
                        )
                    if response.status_code != 200:
                        raise ApiError(
                            502,
                            "BILLING_PROVIDER_REJECTED",
                            "결제 제공자가 요청을 승인하지 않았습니다.",
                        )
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError("Expected payment object")
                    return result
        except ApiError:
            raise
        except (httpx.HTTPError, ValueError, UnicodeError, RecursionError, TimeoutError) as exc:
            raise ApiError(
                503, "BILLING_PROVIDER_UNAVAILABLE", "결제 상태를 확인 중입니다."
            ) from exc

    async def lookup(self, order_id):
        try:
            return await self.request("GET", f"/v1/payments/orders/mori-{order_id}", missing=True)
        except ApiError as exc:
            if exc.code != "BILLING_PROVIDER_REJECTED":
                raise
            # Rejected access to a lookup says nothing about an earlier charge.
            # Keep reconciliation pending instead of allowing a replacement order.
            raise ApiError(
                503, "BILLING_PROVIDER_UNAVAILABLE", "결제 상태를 확인 중입니다."
            ) from exc

    async def issue(self, customer_key, auth_key, order_id):
        data = await self.request(
            "POST",
            "/v1/billing/authorizations/issue",
            body={"customerKey": customer_key, "authKey": auth_key},
            key=f"issue-{order_id}",
        )
        token = data.get("billingKey")
        if (
            data.get("customerKey") != customer_key
            or not isinstance(token, str)
            or not 1 <= len(token) <= 500
        ):
            raise ApiError(502, "INVALID_BILLING_RESPONSE", "결제 수단을 확인하지 못했습니다.")
        return token

    async def charge(self, billing_key, customer_key, order_id, amount):
        return await self.request(
            "POST",
            "/v1/billing/" + quote(billing_key, safe=""),
            body={
                "customerKey": customer_key,
                "amount": amount,
                "orderId": f"mori-{order_id}",
                "orderName": "Mori Pro 월 구독",
            },
            key=f"charge-{order_id}",
        )
