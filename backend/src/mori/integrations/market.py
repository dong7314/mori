from datetime import UTC, datetime, timedelta

from pydantic import ValidationError

from mori.errors import ApiError
from mori.integrations.kis import configured as kis_configured
from mori.integrations.kis import fetch_kis
from mori.integrations.providers import read_provider
from mori.integrations.schemas import Candles, CandlesRead, Quote, QuoteRead

MAX_MARKET_CLOCK_SKEW = timedelta(minutes=5)


async def fetch_market(settings, symbol, *, range=None, transport=None):
    if settings.kis_enabled:
        data = await fetch_kis(settings, symbol, range=range, transport=transport)
        provider = (
            "Korea Investment Open API · KRX 1-minute"
            if data.get("interval") == "1m"
            else "Korea Investment Open API · daily close"
        )
    else:
        if not settings.market_data_base_url:
            raise ApiError(503, "MARKET_DATA_NOT_CONFIGURED", "시세 제공자가 연결되지 않았습니다.")
        path = "/candles" if range else "/quote"
        params = {"symbol": symbol}
        if range:
            params["range"] = range
        key = settings.market_data_api_key.get_secret_value()
        data = await read_provider(
            settings.market_data_base_url + path,
            params=params,
            headers={"Authorization": "Bearer " + key} if key else None,
            transport=transport,
        )
        provider = settings.market_data_provider
    try:
        parsed = (Candles if range else Quote).model_validate(data)
        if parsed.symbol != symbol or (range and parsed.range != range):
            raise ValueError("Mismatched market data")
        if not settings.kis_enabled:
            latest = datetime.now(UTC) + MAX_MARKET_CLOCK_SKEW
            if any(at is not None and at > latest for at in (parsed.as_of, parsed.observed_at)):
                raise ValueError("Future market timestamp")
        values = parsed.model_dump()
        if range:
            return CandlesRead(**values, provider=provider)
        change = parsed.price - parsed.previous_close
        return QuoteRead(
            **values,
            provider=provider,
            change=change,
            change_percent=change / parsed.previous_close * 100,
        )
    except (ValidationError, ValueError) as exc:
        raise ApiError(
            502, "INVALID_MARKET_RESPONSE", "시세 데이터를 확인하지 못했습니다."
        ) from exc


def market_configured(settings):
    return kis_configured(settings) if settings.kis_enabled else bool(settings.market_data_base_url)
