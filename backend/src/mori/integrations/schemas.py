from datetime import datetime
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
    topic: str = ""
    schedule: Schedule | None = None
    status: Literal["empty", "loading", "ready", "failed"] = "empty"
    configured: bool
    articles: list[NewsArticle] = Field(default_factory=list)
    collected_at: datetime | None = None
    error_code: str | None = None


class MarketSettings(Input):
    revision: int = Field(ge=0)
    symbol: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9.^:_-]+$")

    @field_validator("symbol")
    @classmethod
    def canonical_symbol(cls, value):
        return value.upper()


class MarketSettingsRead(BaseModel):
    revision: int
    symbol: str | None
    configured: bool
    provider: str


class Quote(Input):
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


class Candles(Input):
    symbol: str
    range: Literal["day", "week", "month"]
    currency: str = Field(min_length=3, max_length=12)
    as_of: AwareDatetime
    candles: list[Candle] = Field(max_length=500)

    @model_validator(mode="after")
    def chronological(self):
        times = [item.at for item in self.candles]
        if any(left >= right for left, right in zip(times, times[1:], strict=False)):
            raise ValueError("Candles must be unique and ordered by time")
        if times and times[-1] > self.as_of:
            raise ValueError("Candle timestamps must not exceed as_of")
        return self


class CandlesRead(Candles):
    provider: str
