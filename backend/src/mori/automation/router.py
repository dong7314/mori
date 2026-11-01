from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.automation.models import AutomationJob
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES

router = APIRouter(prefix="/v1/automation", tags=["automation"], responses=PRIVATE_API_RESPONSES)


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    feature_id: UUID
    scheduled_at: datetime
    status: Literal["pending", "running", "completed", "failed", "cancelled"]
    attempts: int
    run_id: UUID | None
    error_code: str | None
    created_at: datetime
    completed_at: datetime | None


@router.get("/jobs", response_model=list[JobRead])
def jobs(
    user: CurrentUser,
    session: DatabaseSession,
    feature_id: UUID | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    query = select(AutomationJob).where(AutomationJob.user_id == user.id)
    if feature_id:
        query = query.where(AutomationJob.feature_id == feature_id)
    return list(
        session.scalars(
            query.order_by(AutomationJob.scheduled_at.desc(), AutomationJob.id.desc())
            .offset(offset)
            .limit(limit)
        )
    )
