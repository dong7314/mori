from pydantic import ValidationError

from mori.errors import ApiError
from mori.integrations.providers import read_provider
from mori.integrations.schemas import Candles, CandlesRead, Quote, QuoteRead


async def fetch_market(settings, symbol, *, range=None, transport=None):
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
    try:
        parsed = (Candles if range else Quote).model_validate(data)
        if parsed.symbol != symbol or (range and parsed.range != range):
            raise ValueError("Mismatched market data")
        values = parsed.model_dump()
        if range:
            return CandlesRead(**values, provider=settings.market_data_provider)
        change = parsed.price - parsed.previous_close
        return QuoteRead(
            **values,
            provider=settings.market_data_provider,
            change=change,
            change_percent=change / parsed.previous_close * 100,
        )
    except (ValidationError, ValueError) as exc:
        raise ApiError(
            502, "INVALID_MARKET_RESPONSE", "시세 데이터를 확인하지 못했습니다."
        ) from exc
