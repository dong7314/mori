from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=4000)

    @field_validator("message")
    @classmethod
    def clean_message(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 32 and c not in "\n\t" for c in value):
            raise ValueError("Provide a nonempty text message")
        return value


class Source(BaseModel):
    title: str
    url: str
    evidence: Literal["search", "extract"]


class ToolResult(BaseModel):
    name: Literal["web_search", "web_extract", "mori_image_search"]
    status: Literal["succeeded", "failed"]
    result_count: int


class SearchResponse(BaseModel):
    request_id: UUID
    answer: str
    sources: list[Source]
    tools: list[ToolResult]
