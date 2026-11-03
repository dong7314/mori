import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from mori.billing.settings import BillingMarketSettings
from mori.errors import ApiError
from mori.integrations.kis import TOKENS, fetch_kis
from mori.integrations.schemas import Candles, Quote


@pytest.mark.parametrize(
    "symbol,path,tr,fields",
    [
        (
            "005930.KS",
            "inquire-daily-itemchartprice",
            "FHKST03010100",
            ("stck_bsop_date", "stck_oprc", "stck_hgpr", "stck_lwpr", "stck_clpr", "acml_vol"),
        ),
        (
            "KOSPI",
            "inquire-daily-indexchartprice",
            "FHKUP03500100",
            (
                "stck_bsop_date",
                "bstp_nmix_oprc",
                "bstp_nmix_hgpr",
                "bstp_nmix_lwpr",
                "bstp_nmix_prpr",
                "acml_vol",
            ),
        ),
        ("AAPL", "dailyprice", "HHDFS76240000", ("xymd", "open", "high", "low", "clos", "tvol")),
    ],
)
def test_kis_dated_prices_and_candles_do_not_claim_realtime(symbol, path, tr, fields):
    TOKENS.clear()
    settings = BillingMarketSettings(kis_enabled=True, kis_app_key="key", kis_app_secret="secret")
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.host == "openapi.koreainvestment.com"
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "cached-access", "expires_in": 86400})
        assert request.url.path.endswith(path)
        assert request.headers["tr_id"] == tr
        rows = [
            dict(zip(fields, values, strict=True))
            for values in [
                ("20261102", "30", "35", "25", "32", "20"),
                ("20261030", "20", "25", "15", "22", "10"),
                ("20261029", "19", "22", "15", "20", "11"),
            ]
        ]
        return httpx.Response(200, json={"rt_cd": "0", "output2": rows})

    transport = httpx.MockTransport(handle)
    now = datetime(2026, 11, 2, 12, tzinfo=UTC)
    result = asyncio.run(fetch_kis(settings, symbol, transport=transport, now=now))
    quote = Quote.model_validate(result)
    assert quote.price == 22 and quote.previous_close == 20
    assert quote.price_kind == "close" and quote.as_of_precision == "session_date"
    assert quote.as_of.date().isoformat() == "2026-10-30"
    candles = Candles.model_validate(
        asyncio.run(fetch_kis(settings, symbol, range="week", transport=transport, now=now))
    )
    assert len(candles.candles) == 2 and candles.candles[0].close == 20
    assert sum(request.method == "POST" for request in calls) == 1


def test_unknown_exchange_never_issues_external_request():
    settings = BillingMarketSettings(kis_enabled=True, kis_app_key="key", kis_app_secret="secret")

    def forbidden(request):
        raise AssertionError("Network must not be used")

    with pytest.raises(ApiError) as error:
        asyncio.run(fetch_kis(settings, "UNLISTED", transport=httpx.MockTransport(forbidden)))
    assert error.value.code == "UNSUPPORTED_MARKET_SYMBOL"


def test_provider_error_does_not_expose_credentials():
    TOKENS.clear()
    settings = BillingMarketSettings(
        kis_enabled=True, kis_app_key="private-key", kis_app_secret="private-secret"
    )

    def denied(request):
        return httpx.Response(500, json={"message": "private-secret"})

    with pytest.raises(ApiError) as error:
        asyncio.run(fetch_kis(settings, "AAPL", transport=httpx.MockTransport(denied)))
    assert "private-secret" not in str(error.value)
