from datetime import date, datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from mori.features.schemas import Schedule
from mori.organizer.schemas import Clock, Input


class NewsSettings(Input):
    revision: int = Field(ge=0)
    topic: str = Field(min_length=1, max_length=60)
    schedule: Schedule | None = None
    time: Clock | None = None

    @model_validator(mode="after")
    def daily_time(self):
        if self.time:
            if self.schedule is not None:
                raise ValueError("Use time or schedule, not both")
            self.schedule = Schedule(time=self.time, repeat="daily")
        return self


class NewsArticle(Input):
    id: UUID
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(max_length=2000)
    summary_type: Literal["search_excerpt"] = "search_excerpt"
    url: str = Field(max_length=2048)
    source: str = Field(min_length=1, max_length=255)
    published_at: AwareDatetime | None = None

    @field_validator("url")
    @classmethod
    def public_article_url(cls, value):
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or any(ord(c) < 33 for c in value)
        ):
            raise ValueError("Article URL must be an HTTP(S) URL without credentials")
        return value


class NewsRead(BaseModel):
    feature_id: UUID | None = None
    revision: int = 0
    feature_status: Literal["draft", "active", "paused"] | None = None
    topic: str = ""
    schedule: Schedule | None = None
    status: Literal["empty", "loading", "ready", "failed"] = "empty"
    configured: bool
    articles: list[NewsArticle] = Field(default_factory=list)
    collected_at: datetime | None = None
    result_is_stale: bool = Field(
        default=False,
        description="The last successful collection is retained during a retry or failure.",
    )
    error_code: str | None = None
    summary_text: str | None = None
    summary_kind: Literal["ai_search_excerpt_summary"] | None = None
    summary_status: Literal["not_requested", "ready", "failed", "empty"] = "not_requested"
    summary_error_code: str | None = None


class MarketSettings(Input):
    revision: int = Field(ge=0)
    symbol: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9.^:_-]+$")
    schedule: Schedule | None = Field(
        default=None,
        description="Omit to retain the existing schedule; explicit null removes it.",
    )
    feature_revision: int | None = Field(
        default=None, ge=1, description="Required when changing an existing stock feature schedule."
    )

    @field_validator("symbol")
    @classmethod
    def canonical_symbol(cls, value):
        return value.upper()


class MarketSettingsRead(BaseModel):
    revision: int
    symbol: str | None
    configured: bool
    provider: str
    feature_id: UUID | None = None
    feature_revision: int | None = None
    schedule: Schedule | None = None


class MarketPrecision(Input):
    price_kind: Literal["provider_quote", "close", "intraday"] = "provider_quote"
    as_of_precision: Literal["instant", "session_date", "minute"] = "instant"
    observed_at: AwareDatetime | None = None


class Quote(MarketPrecision):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    symbol: str
    currency: str = Field(min_length=3, max_length=12)
    price: float = Field(gt=0)
    previous_close: float = Field(gt=0)
    as_of: AwareDatetime


class QuoteRead(Quote):
    provider: str
    change: float
    change_percent: float


class Candle(Input):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    at: AwareDatetime
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float = Field(ge=0)

    @model_validator(mode="after")
    def valid_ohlc(self):
        if not self.low <= min(self.open, self.close) <= max(self.open, self.close) <= self.high:
            raise ValueError("Invalid OHLC bounds")
        return self


class Candles(MarketPrecision):
    symbol: str
    range: Literal["day", "week", "month"]
    currency: str = Field(min_length=3, max_length=12)
    as_of: AwareDatetime | None
    interval: Literal["provider", "1d", "1m"] = "provider"
    timezone: str | None = None
    session_date: date | None = None
    empty_reason: Literal["before_session", "non_trading_day", "no_current_session_data"] | None = (
        None
    )
    truncated: bool = False
    candles: list[Candle] = Field(max_length=500)

    @model_validator(mode="after")
    def chronological(self):
        times = [item.at for item in self.candles]
        if times and (self.as_of is None or self.empty_reason is not None):
            raise ValueError("Nonempty candles require as_of and no empty reason")
        if any(left >= right for left, right in zip(times, times[1:], strict=False)):
            raise ValueError("Candles must be unique and ordered by time")
        if times and times[-1] > self.as_of:
            raise ValueError("Candle timestamps must not exceed as_of")
        return self


class CandlesRead(Candles):
    provider: str
