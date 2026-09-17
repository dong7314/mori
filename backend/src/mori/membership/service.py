from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from mori.auth.models import SocialIdentity, User
from mori.errors import ApiError
from mori.membership.models import AccessChange
from mori.membership.schemas import AccessDecision
from mori.membership.types import AccessAction, AccountRole, AccountTier


def has_social_identity(session: Session, user_id: UUID) -> bool:
    return (
        session.scalar(select(SocialIdentity.id).where(SocialIdentity.user_id == user_id).limit(1))
        is not None
    )


def change_pro_access(
    session: Session, actor_id: UUID, user_id: UUID, tier: AccountTier, decision: AccessDecision
) -> User:
    # Recheck authority under the same locks as the change. Fixed order also covers self-approval
    # and two administrators changing each other's tiers without cyclic row locks.
    locked = {
        user.id: user
        for user in session.scalars(
            select(User)
            .where(User.id.in_({actor_id, user_id}))
            .order_by(User.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }
    actor = locked.get(actor_id)
    if actor is None or actor.role != AccountRole.SUPER_ADMIN:
        raise ApiError(403, "SUPER_ADMIN_REQUIRED", "최고 관리자만 사용할 수 있습니다.")
    user = locked.get(user_id)
    if user is None or not has_social_identity(session, user_id):
        raise ApiError(404, "USER_NOT_FOUND", "소셜 가입한 사용자를 찾을 수 없습니다.")
    if user.tier != tier:
        user.tier = tier
        session.add(
            AccessChange(
                user_id=user_id,
                actor_id=actor_id,
                action=AccessAction.APPROVE_PRO
                if tier == AccountTier.PRO
                else AccessAction.REVOKE_PRO,
                reason=decision.reason,
            )
        )
    # Repeating the same decision is a no-op, including its audit entry.
    session.commit()
    return user


def set_super_admin(
    session: Session, user_id: UUID, *, enabled: bool, decision: AccessDecision
) -> User:
    """Trusted operator CLI only. Does not create accounts or grant Pro access."""
    user = session.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None or not has_social_identity(session, user_id):
        raise ApiError(404, "USER_NOT_FOUND", "소셜 가입한 사용자를 찾을 수 없습니다.")
    role = AccountRole.SUPER_ADMIN if enabled else AccountRole.USER
    if user.role != role:
        user.role = role
        session.add(
            AccessChange(
                user_id=user_id,
                actor_id=None,
                action=AccessAction.GRANT_SUPER_ADMIN
                if enabled
                else AccessAction.REVOKE_SUPER_ADMIN,
                reason=decision.reason,
            )
        )
    session.commit()
    return user
