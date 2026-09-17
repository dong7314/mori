from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, StringConstraints

from mori.membership.types import AccessAction, AccountRole, AccountTier

Reason = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]+$"
    ),
]


class AccessDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Reason


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_name: str
    tier: AccountTier
    role: AccountRole
    created_at: datetime


class MemberPage(BaseModel):
    items: list[MemberResponse]
    next_cursor: UUID | None


class AccessChangeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    actor_id: UUID | None
    action: AccessAction
    reason: str
    created_at: datetime
