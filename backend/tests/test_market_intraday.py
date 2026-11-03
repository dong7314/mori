import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import SecretStr

from mori.billing.settings import BillingMarketSettings
from mori.errors import ApiError
from mori.integrations import kis
from mori.integrations.market import fetch_market
from mori.integrations.router import get_integration_transport
from mori.integrations.schemas import Candles

SEOUL = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 11, 3, 10, 0, 30, tzinfo=SEOUL)


@pytest.fixture(autouse=True)
def isolated_kis(monkeypatch):
    kis.TOKENS.clear()
    monkeypatch.setattr(kis, "INTRADAY_PAGE_PAUSE", 0)
    yield
    kis.TOKENS.clear()


def settings():
    return BillingMarketSettings(kis_enabled=True, kis_app_key="key", kis_app_secret="secret")


def bar(clock="095900", day="20261103", **values):
    return {
        "stck_bsop_date": day,
        "stck_cntg_hour": clock,
        "stck_oprc": "70000",
        "stck_hgpr": "70200",
        "stck_lwpr": "69900",
        "stck_prpr": "70100",
        "cntg_vol": "123",
        "acml_vol": "999999",
        **values,
    }


def bars(start, count):
    return [bar((start + timedelta(minutes=i)).strftime("%H%M%S")) for i in range(count)]


def transport_for(handler, requests):
    def handle(request):
        requests.append(request)
        assert request.url.host == "openapi.koreainvestment.com"
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "access", "expires_in": 86400})
        assert request.url.path.endswith("inquire-time-itemchartprice")
        assert request.headers["tr_id"] == "FHKST03010200"
        assert request.url.params["FID_INPUT_ISCD"] == "005930"
        assert request.url.params["FID_COND_MRKT_DIV_CODE"] == "J"
        assert request.url.params["FID_PW_DATA_INCU_YN"] == "Y"
        return handler(request)

    return httpx.MockTransport(handle)


def fetch(handler, *, now=NOW, calls=None):
    calls = [] if calls is None else calls
    result = asyncio.run(
        kis.fetch_kis(
            settings(), "005930.KS", range="day", transport=transport_for(handler, calls), now=now
        )
    )
    return Candles.model_validate(result)


def response(rows):
    return httpx.Response(200, json={"rt_cd": "0", "output2": rows})


def test_kis_day_walks_time_cursor_orders_and_deduplicates_completed_minutes():
    calls = []
    opening = NOW.replace(hour=9, minute=0, second=0)
    pages = iter(
        [
            bars(opening + timedelta(minutes=30), 30),
            [bar("093000"), *reversed(bars(opening + timedelta(minutes=1), 29))],
            [bar("090000")],
        ]
    )
    data = fetch(lambda _: response(next(pages)), calls=calls)
    assert len(data.candles) == 60 and not data.truncated
    assert data.candles[0].at == opening and data.candles[-1].at.hour == 9
    assert data.candles[-1].at.minute == 59 and data.as_of == data.candles[-1].at
    assert data.candles[-1].volume == 123  # Per-minute volume, not cumulative session volume.
    assert data.interval == "1m" and data.price_kind == "intraday"
    assert data.as_of_precision == "minute" and data.timezone == "Asia/Seoul"
    assert data.session_date == NOW.date() and data.observed_at == NOW
    assert data.empty_reason is None
    assert [r.url.params["FID_INPUT_HOUR_1"] for r in calls if r.method == "GET"] == [
        "100000",
        "093000",
        "090100",
    ]


def test_day_excludes_current_future_and_other_session_candles():
    data = fetch(
        lambda _: response(
            [bar("100100"), bar("100000"), bar("095900"), bar("095800", day="20261102")]
        )
    )
    assert [c.at.strftime("%H%M%S") for c in data.candles] == ["095900"]
    assert data.as_of.astimezone(UTC).hour == 0


@pytest.mark.parametrize(
    "now,reason",
    [
        (NOW.replace(hour=8), "before_session"),
        (NOW.replace(hour=9, minute=0), "no_current_session_data"),
        (NOW.replace(day=7), "non_trading_day"),
    ],
)
def test_before_open_or_weekend_returns_empty_without_provider_request(now, reason):
    calls = []
    data = fetch(lambda _: pytest.fail("Provider must not be contacted"), now=now, calls=calls)
    assert calls == [] and data.candles == [] and data.as_of is None
    assert data.empty_reason == reason and not data.truncated


@pytest.mark.parametrize("rows", [[], [bar(day="20261102")]])
def test_holiday_or_no_current_session_data_does_not_substitute_yesterday(rows):
    data = fetch(lambda _: response(rows))
    assert data.candles == [] and data.as_of is None
    assert data.empty_reason == "no_current_session_data" and data.session_date == NOW.date()


@pytest.mark.parametrize("inclusive", [True, False])
@pytest.mark.parametrize(
    "hour,minute,expected",
    [(9, 1, 1), (10, 0, 60), (15, 30, 390), (15, 31, 391), (18, 0, 391)],
)
def test_cursor_boundaries_preserve_every_completed_minute_with_bounded_requests(
    inclusive, hour, minute, expected
):
    opening = NOW.replace(hour=9, minute=0, second=0)
    rows = bars(opening, 391)
    calls = []

    def handle(request):
        cursor = request.url.params["FID_INPUT_HOUR_1"]
        eligible = [
            row
            for row in rows
            if row["stck_cntg_hour"] < cursor or (inclusive and row["stck_cntg_hour"] == cursor)
        ]
        return response(list(reversed(eligible[-30:])))

    data = fetch(handle, now=NOW.replace(hour=hour, minute=minute), calls=calls)
    assert [c.at for c in data.candles] == [opening + timedelta(minutes=i) for i in range(expected)]
    assert data.as_of == opening + timedelta(minutes=expected - 1) and not data.truncated
    assert len([r for r in calls if r.method == "GET"]) <= 14


def test_page_limit_is_reported_instead_of_claiming_complete_session(monkeypatch):
    monkeypatch.setattr(kis, "INTRADAY_MAX_PAGES", 1)
    data = fetch(lambda _: response(bars(NOW.replace(hour=9, minute=30, second=0), 30)))
    assert len(data.candles) == 30 and data.truncated


@pytest.mark.parametrize(
    "row",
    [
        bar(stck_lwpr="80000"),
        bar(stck_prpr="NaN"),
        bar(cntg_vol="-1"),
        bar(stck_oprc="0"),
        bar(clock="096000"),
        bar(clock="095901"),
        bar(clock="0９5900"),
        bar(day="20261303"),
        {"stck_bsop_date": "20261103"},
    ],
)
def test_malformed_intraday_data_fails_without_fake_price(row):
    with pytest.raises(ApiError) as error:
        fetch(lambda _: response([row]))
    assert error.value.code == "INVALID_MARKET_RESPONSE"


def test_conflicting_duplicates_and_stalled_pages_are_rejected():
    with pytest.raises(ApiError):
        fetch(lambda _: response([bar(), bar(stck_prpr="70001")]))
    page = bars(NOW.replace(hour=9, minute=30, second=0), 30)
    with pytest.raises(ApiError) as error:
        fetch(lambda _: response(page))
    assert error.value.code == "INVALID_MARKET_RESPONSE"


@pytest.mark.parametrize(
    "bad", [response([bar()] * 31), httpx.Response(200, content=b"x" * 2_000_001)]
)
def test_page_and_response_size_limits(bad):
    with pytest.raises(ApiError) as error:
        fetch(lambda _: bad)
    assert error.value.code == "INVALID_MARKET_RESPONSE"


@pytest.mark.parametrize(
    "failure,code",
    [
        (httpx.Response(429), "PROVIDER_RATE_LIMITED"),
        (httpx.Response(500, text="private-secret"), "PROVIDER_UNAVAILABLE"),
        (
            httpx.Response(302, headers={"Location": "https://other.invalid"}),
            "PROVIDER_UNAVAILABLE",
        ),
        (
            httpx.Response(200, json={"rt_cd": "1", "msg1": "private-secret"}),
            "INVALID_MARKET_RESPONSE",
        ),
    ],
)
def test_second_page_failure_never_returns_partial_success_or_provider_secrets(failure, code):
    replies = iter([response(bars(NOW.replace(hour=9, minute=30, second=0), 30)), failure])
    with pytest.raises(ApiError) as error:
        fetch(lambda _: next(replies))
    assert error.value.code == code and "private-secret" not in str(error.value)


def test_network_timeout_is_bounded_and_reported():
    def timeout(request):
        raise httpx.ReadTimeout("private-secret", request=request)

    with pytest.raises(ApiError) as error:
        fetch(timeout)
    assert error.value.code == "INVALID_MARKET_RESPONSE"
    assert "private-secret" not in str(error.value)


def test_entire_page_walk_has_one_deadline(monkeypatch):
    monkeypatch.setattr(kis, "REQUEST_DEADLINE_SECONDS", 0.01)

    async def delayed(request):
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={"access_token": "access", "expires_in": 86400})

    with pytest.raises(ApiError) as error:
        asyncio.run(
            kis.fetch_kis(
                settings(), "005930", range="day", transport=httpx.MockTransport(delayed), now=NOW
            )
        )
    assert error.value.code == "INVALID_MARKET_RESPONSE"


def freeze_clock(monkeypatch):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW.astimezone(tz or UTC)

    monkeypatch.setattr(kis, "datetime", FixedDateTime)


def test_market_candles_endpoint_exposes_minute_metadata_and_requires_auth(
    client, accounts, monkeypatch
):
    freeze_clock(monkeypatch)
    client.app.state.settings.kis_enabled = True
    client.app.state.settings.kis_app_key = SecretStr("key")
    client.app.state.settings.kis_app_secret = SecretStr("secret")
    calls = []
    client.app.dependency_overrides[get_integration_transport] = lambda: transport_for(
        lambda _: response([bar()]), calls
    )
    url = "/v1/market/candles?range=day&symbol=005930"
    assert client.get(url).status_code == 401 and calls == []
    result = client.get(url, headers=accounts["alice"]["headers"])
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["interval"] == "1m" and data["price_kind"] == "intraday"
    assert data["provider"] == "Korea Investment Open API · KRX 1-minute"
    assert data["as_of"] == "2026-11-03T09:59:00+09:00"


@pytest.mark.parametrize(
    "symbol,period", [("005930", "week"), ("005930", "month"), ("KOSPI", "day"), ("AAPL", "day")]
)
def test_other_ranges_and_instruments_keep_daily_close_contract(symbol, period, monkeypatch):
    freeze_clock(monkeypatch)

    def handle(request):
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "access", "expires_in": 86400})
        assert not request.url.path.endswith("inquire-time-itemchartprice")
        fields = (
            ("xymd", "open", "high", "low", "clos", "tvol")
            if symbol == "AAPL"
            else (
                "stck_bsop_date",
                "bstp_nmix_oprc",
                "bstp_nmix_hgpr",
                "bstp_nmix_lwpr",
                "bstp_nmix_prpr",
                "acml_vol",
            )
            if symbol == "KOSPI"
            else ("stck_bsop_date", "stck_oprc", "stck_hgpr", "stck_lwpr", "stck_clpr", "acml_vol")
        )
        return response(
            [dict(zip(fields, ("20261030", "30", "35", "25", "32", "20"), strict=True))]
        )

    data = asyncio.run(
        fetch_market(settings(), symbol, range=period, transport=httpx.MockTransport(handle))
    )
    assert data.interval == "1d" and data.price_kind == "close"
    assert data.as_of_precision == "session_date" and len(data.candles) == 1
