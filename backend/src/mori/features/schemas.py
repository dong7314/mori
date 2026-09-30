from datetime import date as Date
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from mori.organizer.schemas import Clock, Input, RecordRead, Revision, Title, valid_zone


class Schedule(Input):
    time: Clock
    timezone: str = Field(default="Asia/Seoul", max_length=64)
    repeat: Literal["once", "daily", "weekdays"]
    date: Date | None = None
    _zone = field_validator("timezone")(valid_zone)

    @model_validator(mode="after")
    def once_date(self):
        if (self.repeat == "once") != (self.date is not None):
            raise ValueError("One-off schedules require a date; repeating schedules omit it")
        return self


class FeatureWrite(Input):
    title: Title = "나만의 기능"
    description: str = Field(default="", max_length=180)
    work: str = Field(default="", max_length=2000)
    reference: str = Field(default="", max_length=6000)
    icon: Literal["spark", "note", "news", "bell", "calendar", "chart"] = "spark"
    schedule: Schedule | None = None


class FeatureCreate(FeatureWrite):
    builtin_key: Literal["news", "stock"] | None = None


class FeatureUpdate(FeatureWrite, Revision):
    pass


class FeatureRead(FeatureWrite, RecordRead):
    builtin_key: str | None
    status: Literal["draft", "active", "paused"]
    version: int
    template_key: Literal["standard"] = "standard"
    template_version: int = 1
    automation_status: Literal["not_configured", "not_requested"] = "not_requested"
    execution_available: bool = True


class FeatureResultRead(RecordRead):
    feature_id: UUID
    feature_version: int
    run_id: UUID
    title: str
    text: str
    template_key: Literal["text"] = "text"
    template_version: int = 1


class FeatureState(Revision):
    status: Literal["active", "paused"]


class CatalogItem(Input):
    key: str
    title: str
    icon: str
    template_key: str


class Capabilities(Input):
    scheduled_execution: bool
    push_delivery: bool
    market_data: bool
    office_conversion: bool
    text_document_storage: bool
    custom_chat_execution: bool


class CatalogRead(Input):
    items: list[CatalogItem]
    template_version: int
    capabilities: Capabilities
