from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Clock = Annotated[str, StringConstraints(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]
DOCUMENT_MAX_BYTES = 10_000_000


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("*", mode="before")
    @classmethod
    def no_controls(cls, value):
        if isinstance(value, str) and any(ord(c) < 32 and c not in "\n\t\r" for c in value):
            raise ValueError("Unsupported control character")
        return value


def valid_zone(value):
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Use an IANA timezone") from exc
    return value


class Revision(Input):
    revision: int = Field(ge=1)


class RecordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    revision: int
    created_at: AwareDatetime
    updated_at: AwareDatetime
    deleted_at: AwareDatetime | None = None


class NoteWrite(Input):
    title: Title
    body: str = Field(default="", max_length=12000)


class NoteUpdate(NoteWrite, Revision):
    pass


class NoteRead(NoteWrite, RecordRead):
    pass


class EventWrite(Input):
    title: Title
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    timezone: str = Field(default="Asia/Seoul", max_length=64)
    all_day: bool = False
    category: Literal["work", "appointment", "personal"] = "appointment"
    place: str = Field(default="", max_length=120)
    memo: str = Field(default="", max_length=1000)

    _zone = field_validator("timezone")(valid_zone)

    @model_validator(mode="after")
    def interval(self):
        if self.ends_at <= self.starts_at or (self.ends_at - self.starts_at).days > 366:
            raise ValueError("Invalid event interval")
        if self.all_day:
            zone = ZoneInfo(self.timezone)
            for value in (self.starts_at, self.ends_at):
                if value.astimezone(zone).time().isoformat() != "00:00:00":
                    raise ValueError("All-day boundaries must be local midnight; end is exclusive")
        return self


class EventUpdate(EventWrite, Revision):
    pass


class EventRead(EventWrite, RecordRead):
    pass


class EventList(BaseModel):
    items: list[EventRead]
    limit: int
    offset: int


class ReminderWrite(Input):
    title: Title
    target_at: AwareDatetime


class ReminderUpdate(ReminderWrite, Revision):
    pass


class ReminderRead(ReminderWrite, RecordRead):
    cancelled: bool
    delivery_status: Literal["not_configured"] = "not_configured"


class DocumentWrite(Input):
    title: Title
    filename: str = Field(min_length=1, max_length=120)
    text: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(
        min_length=1,
        max_length=DOCUMENT_MAX_BYTES,
        description="Original TXT/MD/CSV content; maximum 10 MB (10,000,000 UTF-8 bytes).",
    )

    @field_validator("filename")
    @classmethod
    def filename_valid(cls, value):
        if (
            any(ord(c) < 32 or ord(c) == 127 for c in value)
            or "/" in value
            or "\\" in value
            or not value.lower().endswith((".txt", ".md", ".csv"))
        ):
            raise ValueError("Only plain text documents are supported")
        return value

    @field_validator("text")
    @classmethod
    def byte_limit(cls, value):
        if len(value.encode("utf-8")) > DOCUMENT_MAX_BYTES:
            raise ValueError("Text limit is 10000000 UTF-8 bytes")
        return value


class DocumentRead(DocumentWrite, RecordRead):
    processing: Literal["stored_original"] = "stored_original"


class DocumentSummaryRead(RecordRead):
    title: str
    filename: str
    size_bytes: int
    processing: Literal["stored_original"] = "stored_original"


class AssistantPreferences(Input):
    """Internal assistant context, not an account settings API."""

    model_config = ConfigDict(extra="ignore")
    timezone: str = Field(default="Asia/Seoul", max_length=64)
    commute_time: Clock | None = None
    commute_days: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4], max_length=7)
    parking_lead_minutes: int = Field(default=30, ge=0, le=180)
    parking_enabled: bool = True

    _zone = field_validator("timezone")(valid_zone)

    @field_validator("commute_days")
    @classmethod
    def weekdays(cls, value):
        if len(set(value)) != len(value) or any(
            type(v) is not int or v < 0 or v > 6 for v in value
        ):
            raise ValueError("Weekdays use Monday=0 through Sunday=6, without duplicates")
        return sorted(value)


class LibraryItem(BaseModel):
    id: UUID
    kind: Literal["note", "document", "feature_result"]
    title: str
    description: str
    updated_at: datetime
    detail_url: str
