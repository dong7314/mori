from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query
from sqlalchemy import select

from mori.auth.models import SocialIdentity, User
from mori.database import DatabaseSession
from mori.errors import ErrorResponse
from mori.membership.dependencies import CurrentSuperAdmin
from mori.membership.models import AccessChange
from mori.membership.schemas import AccessChangeResponse, AccessDecision, MemberPage, MemberResponse
from mori.membership.service import change_pro_access
from mori.membership.types import AccountTier

router = APIRouter(
    prefix="/v1/admin/users",
    tags=["admin"],
    responses={status: {"model": ErrorResponse} for status in (401, 403, 404, 422, 503)},
)


@router.get("", response_model=MemberPage, summary="최고 관리자: 소셜 가입자 목록")
def list_members(
    admin: CurrentSuperAdmin,
    session: DatabaseSession,
    cursor: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    tier: AccountTier | None = None,
):
    query = select(User).where(
        select(SocialIdentity.id).where(SocialIdentity.user_id == User.id).exists()
    )
    if cursor is not None:
        query = query.where(User.id > cursor)
    if tier is not None:
        query = query.where(User.tier == tier)
    users = session.scalars(query.order_by(User.id).limit(limit + 1)).all()
    return MemberPage(
        items=[MemberResponse.model_validate(user) for user in users[:limit]],
        next_cursor=users[limit - 1].id if len(users) > limit else None,
    )


@router.post("/{user_id}/pro/approve", response_model=MemberResponse, summary="프로 사용 승인")
def approve_pro(
    user_id: UUID, payload: AccessDecision, admin: CurrentSuperAdmin, session: DatabaseSession
):
    return change_pro_access(session, admin.id, user_id, AccountTier.PRO, payload)


@router.post(
    "/{user_id}/pro/revoke", response_model=MemberResponse, summary="프로 승인 회수·무료 전환"
)
def revoke_pro(
    user_id: UUID, payload: AccessDecision, admin: CurrentSuperAdmin, session: DatabaseSession
):
    return change_pro_access(session, admin.id, user_id, AccountTier.FREE, payload)


@router.get(
    "/{user_id}/access-history",
    response_model=list[AccessChangeResponse],
    summary="최고 관리자: 최근 권한 변경 이력",
)
def access_history(
    user_id: UUID,
    admin: CurrentSuperAdmin,
    session: DatabaseSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return session.scalars(
        select(AccessChange)
        .where(AccessChange.user_id == user_id)
        .order_by(AccessChange.created_at.desc(), AccessChange.id.desc())
        .limit(limit)
    ).all()
