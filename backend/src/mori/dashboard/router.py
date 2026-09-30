from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import AwareDatetime

from mori.auth.dependencies import CurrentUser
from mori.dashboard.schemas import DashboardRead, LibraryRead
from mori.dashboard.service import library, timeline
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1", tags=["dashboard"])


@router.get("/dashboard", response_model=DashboardRead)
def dashboard(
    user: CurrentUser,
    session: DatabaseSession,
    hours: int = Query(0, json_schema_extra={"enum": [0, 3, 5, 24]}),
    at: AwareDatetime | None = None,
    limit: int = Query(200, ge=1, le=500),
):
    if hours not in (0, 3, 5, 24):
        raise ApiError(422, "INVALID_WINDOW", "지금, 3시간, 5시간, 하루 중 선택해 주세요.")
    at = at or datetime.now(UTC)
    if not 1970 <= at.year <= 2200:
        raise ApiError(422, "INVALID_RANGE", "조회 시각은 1970년부터 2200년까지 지원합니다.")
    return timeline(session, user.id, hours, at, limit)


@router.get("/library", response_model=LibraryRead)
def records(
    user: CurrentUser,
    session: DatabaseSession,
    kind: Literal["note", "document", "feature_result"] | None = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    return library(session, user.id, kind, limit, offset)
