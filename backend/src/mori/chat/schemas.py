from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from mori.artifacts.schemas import DocumentRequest
from mori.features.schemas import FeatureCreate
from mori.integrations.schemas import MarketSettings, NewsSettings
from mori.organizer.schemas import EventWrite, NoteWrite, ReminderWrite, Revision, Title
from mori.parking.schemas import ParkingCreate


def clean_text(value: str) -> str:
    if any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError("Unsupported control character")
    return value


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="모리와의 대화", min_length=1, max_length=80)

    _clean_title = field_validator("title")(clean_text)


class ChatAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["file", "document"]
    id: UUID


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    message: str = Field(min_length=1, max_length=4000)
    feature_id: UUID | None = None
    attachments: list[ChatAttachment] = Field(default_factory=list, max_length=3)

    _clean_message = field_validator("message")(clean_text)

    @field_validator("attachments")
    @classmethod
    def unique_attachments(cls, value):
        if len({(a.kind, a.id) for a in value}) != len(value):
            raise ValueError("Attach each document only once")
        return value


class RunAccepted(BaseModel):
    run_id: UUID
    status_url: str
    events_url: str


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal[
        "parking_save",
        "parking_lookup",
        "note_save",
        "event_save",
        "reminder_save",
        "feature_save",
        "feature_run",
        "feature_lookup",
        "reply",
        "batch",
        "document_process",
        "news_settings",
        "news_refresh",
        "market_settings",
        "market_lookup",
    ]
    parking: ParkingCreate | None = None
    note: NoteWrite | None = None
    event: EventWrite | None = None
    reminder: ReminderWrite | None = None
    feature: FeatureCreate | None = None
    document: DocumentRequest | None = None
    news: NewsSettings | None = None
    market: MarketSettings | None = None
    feature_id: UUID | None = None
    reply: str = Field(default="", max_length=16000)
    reminder_requested: bool = False
    actions: list["Decision"] | None = Field(default=None, min_length=2, max_length=4)

    _clean_reply = field_validator("reply")(clean_text)

    @model_validator(mode="after")
    def coherent(self):
        if self.action == "batch":
            if (
                not self.actions
                or self.reply
                or self.reminder_requested
                or any(
                    getattr(self, key) is not None
                    for key in (
                        "parking",
                        "note",
                        "event",
                        "reminder",
                        "feature",
                        "feature_id",
                        "document",
                        "news",
                        "market",
                    )
                )
            ):
                raise ValueError("A batch contains only its actions")
            kinds = [item.action for item in self.actions]
            if len(kinds) != len(set(kinds)) or any(
                item.action
                not in {
                    "parking_save",
                    "note_save",
                    "event_save",
                    "reminder_save",
                    "feature_save",
                    "document_process",
                    "news_settings",
                    "market_settings",
                }
                or item.reminder_requested
                for item in self.actions
            ):
                raise ValueError("A batch contains distinct, fully specified save actions")
            return self
        if self.actions is not None:
            raise ValueError("Only batch accepts actions")
        if (self.action in {"feature_run", "feature_lookup"}) != (self.feature_id is not None):
            raise ValueError("Feature run/lookup requires feature_id, other actions omit it")
        if (self.action in {"news_settings", "news_refresh"}) != (self.news is not None):
            raise ValueError("News actions require only their news settings")
        if (self.action in {"market_settings", "market_lookup"}) != (self.market is not None):
            raise ValueError("Market actions require only their market settings")
        for action, field in (
            ("note_save", "note"),
            ("event_save", "event"),
            ("reminder_save", "reminder"),
            ("feature_save", "feature"),
            ("document_process", "document"),
        ):
            if (self.action == action) != (getattr(self, field) is not None):
                raise ValueError("Action and payload do not match")
        if self.action == "parking_save" and self.parking is None:
            raise ValueError("Parking save requires a location")
        if self.action != "parking_save" and self.parking is not None:
            raise ValueError("Unexpected location")
        if self.action == "reply" and not self.reply.strip():
            raise ValueError("Reply is empty")
        return self


class ConversationRead(ConversationCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    pinned: bool
    revision: int
    created_at: datetime
    updated_at: datetime


class ConversationListRead(ConversationRead):
    last_message: str | None
    last_activity_at: datetime


class ConversationUpdate(Revision):
    title: Title | None = None
    pinned: bool | None = None

    @model_validator(mode="after")
    def has_change(self):
        if self.title is None and self.pinned is None:
            raise ValueError("Provide a title or pinned state")
        return self
