import asyncio
import json

import httpx

from mori.errors import ApiError


async def read_provider(url, *, params, headers=None, transport=None):
    """Bound provider time/body size, do not follow redirects or expose provider errors."""
    try:
        async with (
            asyncio.timeout(15),
            httpx.AsyncClient(
                transport=transport,
                timeout=12,
                follow_redirects=False,
                trust_env=False,
            ) as client,
        ):
            async with client.stream("GET", url, params=params, headers=headers) as response:
                if response.status_code == 429:
                    raise ApiError(
                        503, "PROVIDER_RATE_LIMITED", "제공자의 요청 한도를 초과했습니다."
                    )
                if response.status_code != 200:
                    raise ApiError(502, "PROVIDER_UNAVAILABLE", "외부 데이터 연결에 실패했습니다.")
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 2_000_000:
                        raise ValueError("Provider response too large")
                return json.loads(data)
    except ApiError:
        raise
    except (httpx.HTTPError, ValueError, UnicodeError, RecursionError, TimeoutError) as exc:
        raise ApiError(
            502, "INVALID_PROVIDER_RESPONSE", "외부 데이터를 확인하지 못했습니다."
        ) from exc
