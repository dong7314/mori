from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from mori.features.schemas import FeatureCreate
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


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    message: str = Field(min_length=1, max_length=4000)
    feature_id: UUID | None = None

    _clean_message = field_validator("message")(clean_text)


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
        "reply",
    ]
    parking: ParkingCreate | None = None
    note: NoteWrite | None = None
    event: EventWrite | None = None
    reminder: ReminderWrite | None = None
    feature: FeatureCreate | None = None
    feature_id: UUID | None = None
    reply: str = Field(default="", max_length=16000)
    reminder_requested: bool = False

    _clean_reply = field_validator("reply")(clean_text)

    @model_validator(mode="after")
    def coherent(self):
        if (self.action == "feature_run") != (self.feature_id is not None):
            raise ValueError("feature_run requires feature_id, other actions omit it")
        for action, field in (
            ("note_save", "note"),
            ("event_save", "event"),
            ("reminder_save", "reminder"),
            ("feature_save", "feature"),
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


class ConversationUpdate(Revision):
    title: Title | None = None
    pinned: bool | None = None

    @model_validator(mode="after")
    def has_change(self):
        if self.title is None and self.pinned is None:
            raise ValueError("Provide a title or pinned state")
        return self
