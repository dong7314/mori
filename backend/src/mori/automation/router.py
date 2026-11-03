from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.automation.models import AutomationJob
from mori.automation.scheduler import cancel_job
from mori.chat.models import ChatTurn
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError

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
    next_attempt_at: datetime | None = None
    conversation_id: UUID | None = None
    run_url: str | None = None
    events_url: str | None = None


def read_job(row, conversation_id=None):
    result = JobRead.model_validate(row)
    result.next_attempt_at = row.available_at if row.status == "pending" else None
    if row.run_id and conversation_id:
        result.conversation_id = conversation_id
        result.run_url = f"/v1/conversations/{conversation_id}/runs/{row.run_id}"
        result.events_url = result.run_url + "/events"
    return result


@router.get("/jobs", response_model=list[JobRead])
def jobs(
    user: CurrentUser,
    session: DatabaseSession,
    feature_id: UUID | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    query = (
        select(AutomationJob, ChatTurn.conversation_id)
        .outerjoin(ChatTurn, ChatTurn.id == AutomationJob.run_id)
        .where(AutomationJob.user_id == user.id)
    )
    if feature_id:
        query = query.where(AutomationJob.feature_id == feature_id)
    return [
        read_job(row, conversation_id)
        for row, conversation_id in session.execute(
            query.order_by(AutomationJob.scheduled_at.desc(), AutomationJob.id.desc())
            .offset(offset)
            .limit(limit)
        )
    ]


@router.get("/jobs/{job_id}", response_model=JobRead)
def detail(job_id: UUID, user: CurrentUser, session: DatabaseSession):
    record = session.execute(
        select(AutomationJob, ChatTurn.conversation_id)
        .outerjoin(ChatTurn, ChatTurn.id == AutomationJob.run_id)
        .where(AutomationJob.id == job_id, AutomationJob.user_id == user.id)
    ).first()
    if record is None:
        raise ApiError(404, "AUTOMATION_JOB_NOT_FOUND", "예약 실행을 찾을 수 없습니다.")
    return read_job(*record)


@router.post("/jobs/{job_id}/cancel", response_model=JobRead)
def cancel(job_id: UUID, user: CurrentUser, session: DatabaseSession):
    row = cancel_job(session, user.id, job_id)
    conversation_id = (
        session.scalar(select(ChatTurn.conversation_id).where(ChatTurn.id == row.run_id))
        if row.run_id
        else None
    )
    session.commit()
    return read_job(row, conversation_id)
