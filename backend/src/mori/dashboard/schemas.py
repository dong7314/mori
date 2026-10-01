from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from mori.organizer.schemas import LibraryItem


class LibraryRead(BaseModel):
    items: list[LibraryItem]
    has_more: bool
    next_offset: int | None


class TimelineItem(BaseModel):
    key: str
    kind: Literal["event", "reminder", "parking", "feature"]
    resource_id: str
    title: str
    description: str
    at: datetime
    show_from: datetime
    show_until: datetime | None
    current: bool
    action: Literal["appointment", "notify", "display", "execute"]
    availability: Literal["available", "delivery_not_configured", "automation_not_configured"]
    detail_url: str


class TimelineGroup(BaseModel):
    key: str
    label: str
    items: list[TimelineItem]


class DashboardRead(BaseModel):
    server_time: datetime
    from_at: datetime = Field(alias="from")
    until: datetime
    timezone: str
    hours: Literal[0, 3, 5, 24]
    groups: list[TimelineGroup]
    count: int
    truncated: bool
    next_refresh_at: datetime
    recent_records: list[LibraryItem]
