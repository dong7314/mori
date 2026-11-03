"""Read-only KIS minute bars for Korean shares and dated daily-session prices.

Domestic day charts contain completed minutes from the current KRX session. Other
ranges, indices, US shares and quotes retain their dated daily-close contract.
"""

import asyncio
import hashlib
import json
import re
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from mori.errors import ApiError
from mori.integrations.schemas import Candle

ORIGIN = "https://openapi.koreainvestment.com:9443"
TOKENS = {}
TOKEN_LOCK = asyncio.Lock()
INTRADAY_MAX_PAGES = 14
INTRADAY_PAGE_PAUSE = 0.1
REQUEST_DEADLINE_SECONDS = 20


def configured(settings):
    return bool(
        settings.kis_enabled
        and settings.kis_app_key.get_secret_value()
        and settings.kis_app_secret.get_secret_value()
    )


async def json_request(client, method, path, **kwargs):
    async with client.stream(method, ORIGIN + path, **kwargs) as response:
        raw = bytearray()
        async for chunk in response.aiter_bytes():
            raw.extend(chunk)
            if len(raw) > 2_000_000:
                raise ValueError("KIS response too large")
        if response.status_code == 429:
            raise ApiError(503, "PROVIDER_RATE_LIMITED", "시세 제공자의 요청 한도를 초과했습니다.")
        if response.status_code != 200:
            raise ApiError(502, "PROVIDER_UNAVAILABLE", "시세 제공자에 연결하지 못했습니다.")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("KIS object expected")
        return result


async def access_token(client, settings):
    key, secret = (
        settings.kis_app_key.get_secret_value(),
        settings.kis_app_secret.get_secret_value(),
    )
    identity = hashlib.sha256((key + "\0" + secret).encode()).hexdigest()
    async with TOKEN_LOCK:
        current = TOKENS.get(identity)
        if current and current[1] > time.monotonic():
            return current[0]
        result = await json_request(
            client,
            "POST",
            "/oauth2/tokenP",
            json={"grant_type": "client_credentials", "appkey": key, "appsecret": secret},
        )
        token = result.get("access_token")
        if not isinstance(token, str) or not 1 <= len(token) <= 4096:
            raise ValueError("KIS token missing")
        expires = result.get("expires_in", 0)
        if type(expires) is not int or expires <= 60:
            raise ValueError("KIS token expiry missing")
        if len(TOKENS) >= 16:
            TOKENS.clear()
        TOKENS[identity] = (token, time.monotonic() + min(expires - 60, 86400))
        return token


def instrument(symbol, settings):
    if symbol in {"KOSPI", "^KS11", "KOSDAQ", "^KQ11"}:
        return "index", "0001" if symbol in {"KOSPI", "^KS11"} else "1001", "POINT", "Asia/Seoul"
    if re.fullmatch(r"\d{6}(?:\.KS|\.KQ)?", symbol):
        return "domestic", symbol.split(".")[0], "KRW", "Asia/Seoul"
    if symbol in settings.kis_symbols:
        return "overseas", symbol, "USD", "America/New_York"
    raise ApiError(422, "UNSUPPORTED_MARKET_SYMBOL", "지원하는 종목 코드와 거래소를 확인해 주세요.")


def kis_headers(settings, token, transaction):
    return {
        "authorization": "Bearer " + token,
        "appkey": settings.kis_app_key.get_secret_value(),
        "appsecret": settings.kis_app_secret.get_secret_value(),
        "tr_id": transaction,
        "custtype": "P",
    }


async def intraday(client, settings, symbol, code, now):
    """Walk KIS's 30-bar time cursor backwards; never request a future minute.

    Official contract and field mapping:
    https://github.com/koreainvestment/open-trading-api/tree/main/examples_llm/domestic_stock/inquire_time_itemchartprice
    The provider warns that its current minute can temporarily reuse the prior
    minute's volume. Excluding the current minute avoids presenting it as final.
    """
    zone = ZoneInfo("Asia/Seoul")
    local = now.astimezone(zone)
    opening = local.replace(hour=9, minute=0, second=0, microsecond=0)
    close = local.replace(hour=15, minute=30, second=0, microsecond=0)
    current_minute = local.replace(second=0, microsecond=0)
    cursor = min(current_minute, close + timedelta(minutes=1))
    max_at = min(current_minute - timedelta(minutes=1), close)
    result = dict(
        symbol=symbol,
        currency="KRW",
        range="day",
        as_of=None,
        candles=[],
        price_kind="intraday",
        as_of_precision="minute",
        observed_at=now,
        interval="1m",
        timezone="Asia/Seoul",
        session_date=local.date(),
        empty_reason=None,
        truncated=False,
    )
    if local.weekday() >= 5:
        return {**result, "empty_reason": "non_trading_day"}
    if max_at < opening:
        return {
            **result,
            "empty_reason": "before_session" if local < opening else "no_current_session_data",
        }
    token = await access_token(client, settings)
    headers = kis_headers(settings, token, "FHKST03010200")
    candles = {}
    for page in range(INTRADAY_MAX_PAGES):
        if page:
            await asyncio.sleep(INTRADAY_PAGE_PAUSE)
        response = await json_request(
            client,
            "GET",
            "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
            params={
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": code,
                "FID_INPUT_HOUR_1": cursor.strftime("%H%M%S"),
                "FID_PW_DATA_INCU_YN": "Y",
                "FID_ETC_CLS_CODE": "",
            },
            headers=headers,
        )
        if response.get("rt_cd") != "0":
            raise ValueError("KIS rejected request")
        rows = response.get("output2")
        if not isinstance(rows, list) or len(rows) > 30:
            raise ValueError("Invalid KIS intraday page")
        if not rows:
            break
        page_times = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("Invalid KIS candle")
            day, clock = row["stck_bsop_date"], row["stck_cntg_hour"]
            if (
                not isinstance(day, str)
                or not isinstance(clock, str)
                or not re.fullmatch(r"[0-9]{8}", day)
                or not re.fullmatch(r"[0-9]{4}00", clock)
            ):
                raise ValueError("Invalid KIS minute timestamp")
            at = datetime.strptime(day + clock, "%Y%m%d%H%M%S").replace(tzinfo=zone)
            if at.date() != local.date() or not opening <= at <= max_at:
                continue
            candle = Candle(
                at=at,
                open=row["stck_oprc"],
                high=row["stck_hgpr"],
                low=row["stck_lwpr"],
                close=row["stck_prpr"],
                volume=row["cntg_vol"],
            ).model_dump()
            if at in candles and candles[at] != candle:
                raise ValueError("Conflicting KIS minute")
            candles[at] = candle
            if at <= cursor:
                page_times.append(at)
        if not page_times:
            if candles:
                raise ValueError("KIS time cursor did not advance")
            break
        earliest = min(page_times)
        if earliest <= opening or len(rows) < 30:
            break
        if earliest >= cursor:
            raise ValueError("KIS time cursor did not advance")
        # Overlap the boundary instead of assuming whether KIS includes its
        # input timestamp. Both inclusive and exclusive responses keep all bars.
        cursor = earliest
    else:
        result["truncated"] = True
    result["candles"] = [candles[at] for at in sorted(candles)]
    result["as_of"] = result["candles"][-1]["at"] if candles else None
    result["empty_reason"] = None if candles else "no_current_session_data"
    return result


async def fetch_kis(settings, symbol, *, range=None, transport=None, now=None):
    if not configured(settings):
        raise ApiError(
            503, "MARKET_DATA_NOT_CONFIGURED", "한국투자증권 시세 연결이 설정되지 않았습니다."
        )
    kind, code, currency, zone_name = instrument(symbol, settings)
    now = now or datetime.now(UTC)
    zone = ZoneInfo(zone_name)
    today = now.astimezone(zone).date()
    # Date-only source values retain their date precision in the public response.
    end = today - timedelta(days=1)
    start = end - timedelta(days=90)
    if kind == "overseas":
        path, tr = "/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000"
        params = {
            "AUTH": "",
            "EXCD": settings.kis_symbols[symbol],
            "SYMB": code,
            "GUBN": "0",
            "BYMD": end.strftime("%Y%m%d"),
            "MODP": "1",
        }
        fields = ("xymd", "open", "high", "low", "clos", "tvol")
    else:
        path, tr = (
            ("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100")
            if kind == "index"
            else (
                "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
                "FHKST03010100",
            )
        )
        params = {
            "FID_COND_MRKT_DIV_CODE": "U" if kind == "index" else "J",
            "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": start.strftime("%Y%m%d"),
            "FID_INPUT_DATE_2": end.strftime("%Y%m%d"),
            "FID_PERIOD_DIV_CODE": "D",
        }
        if kind == "domestic":
            params["FID_ORG_ADJ_PRC"] = "0"
        fields = (
            (
                "stck_bsop_date",
                "bstp_nmix_oprc",
                "bstp_nmix_hgpr",
                "bstp_nmix_lwpr",
                "bstp_nmix_prpr",
                "acml_vol",
            )
            if kind == "index"
            else ("stck_bsop_date", "stck_oprc", "stck_hgpr", "stck_lwpr", "stck_clpr", "acml_vol")
        )
    try:
        async with (
            asyncio.timeout(REQUEST_DEADLINE_SECONDS),
            httpx.AsyncClient(
                transport=transport, trust_env=False, follow_redirects=False, timeout=12
            ) as client,
        ):
            if kind == "domestic" and range == "day":
                return await intraday(client, settings, symbol, code, now)
            token = await access_token(client, settings)
            result = await json_request(
                client,
                "GET",
                path,
                params=params,
                headers=kis_headers(settings, token, tr),
            )
        if result.get("rt_cd") != "0":
            raise ValueError("KIS rejected request")
        rows = result.get("output2")
        if not isinstance(rows, list) or len(rows) > 500:
            raise ValueError("Invalid KIS candles")
        candles = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("Invalid KIS candle")
            day = datetime.strptime(row[fields[0]], "%Y%m%d").date()
            if day > end:
                continue
            if day in seen:
                raise ValueError("Duplicate KIS session")
            seen.add(day)
            values = [float(row[field]) for field in fields[1:]]
            candles.append(
                dict(
                    at=datetime.combine(day, datetime.min.time(), zone),
                    open=values[0],
                    high=values[1],
                    low=values[2],
                    close=values[3],
                    volume=values[4],
                )
            )
        candles.sort(key=lambda item: item["at"])
        if len(candles) < (1 if range else 2):
            raise ValueError("Not enough KIS daily sessions")
        latest = candles[-1]
        metadata = {"as_of_precision": "session_date", "price_kind": "close", "observed_at": now}
        if range:
            cutoff = latest["at"] - timedelta(days={"day": 0, "week": 6, "month": 30}[range])
            return dict(
                symbol=symbol,
                currency=currency,
                as_of=latest["at"],
                range=range,
                interval="1d",
                timezone=zone_name,
                candles=[row for row in candles if row["at"] >= cutoff],
                **metadata,
            )
        return dict(
            symbol=symbol,
            currency=currency,
            price=latest["close"],
            previous_close=candles[-2]["close"],
            as_of=latest["at"],
            **metadata,
        )
    except ApiError:
        raise
    except (
        KeyError,
        TypeError,
        ValueError,
        httpx.HTTPError,
        TimeoutError,
        UnicodeError,
        RecursionError,
    ) as exc:
        raise ApiError(
            502, "INVALID_MARKET_RESPONSE", "시세 데이터를 확인하지 못했습니다."
        ) from exc
