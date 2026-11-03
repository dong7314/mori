import json
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mori.organizer.schemas import Input


class FileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    filename: str
    media_type: str
    size_bytes: int
    sha256: str
    created_at: datetime
    deleted_at: datetime | None = None
    purged_at: datetime | None = None


class DocumentRequest(Input):
    operation: Literal["read", "create", "edit", "convert"]
    format: Literal["txt", "md", "csv", "docx", "xlsx", "pdf"] | None = None
    source_file_id: UUID | None = None
    spec: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_operation(self):
        # Match the serialization used by create_job before any request is stored.
        # An arbitrary nested spec can be valid JSON but exceed Pydantic's serializer.
        self.model_dump(mode="json")
        if len(json.dumps(self.spec, ensure_ascii=False, allow_nan=False).encode()) > 200_000:
            raise ValueError("Document spec exceeds 200 KB")
        # JSONB cannot store NUL, including in nested object keys and values.
        pending = [self.spec]
        while pending:
            value = pending.pop()
            if isinstance(value, str) and "\x00" in value:
                raise ValueError("Document spec cannot contain NUL")
            if isinstance(value, dict):
                pending.extend(value.keys())
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
        if self.operation == "create":
            if self.source_file_id is not None or self.format is None:
                raise ValueError("Create needs format and no source")
        elif self.source_file_id is None:
            raise ValueError("Source file required")
        if self.operation in ("read", "edit") and self.format is not None:
            raise ValueError("Source determines format")
        if self.operation == "read" and self.spec:
            raise ValueError("Read does not accept edits")
        if self.operation == "convert" and (
            self.format not in ("txt", "md", "docx", "pdf") or self.spec
        ):
            raise ValueError("Conversion supports text reflow to txt/md/docx/pdf")
        return self


class DocumentJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    operation: Literal["read", "create", "edit", "convert"]
    status: Literal["pending", "running", "completed", "failed", "cancelled"]
    source_file_id: UUID | None
    output_file_id: UUID | None
    result: dict | None
    error_code: str | None
    created_at: datetime
    completed_at: datetime | None
