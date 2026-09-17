from typing import Annotated

from fastapi import Depends

from mori.auth.dependencies import CurrentAuth
from mori.auth.models import User
from mori.errors import ApiError
from mori.membership.types import AccountRole, AccountTier


def get_super_admin(auth: CurrentAuth) -> User:
    if auth.user.role != AccountRole.SUPER_ADMIN:
        raise ApiError(403, "SUPER_ADMIN_REQUIRED", "최고 관리자만 사용할 수 있습니다.")
    return auth.user


def get_pro_user(auth: CurrentAuth) -> User:
    if auth.user.tier != AccountTier.PRO:
        raise ApiError(403, "PRO_REQUIRED", "최고 관리자의 프로 사용 승인이 필요합니다.")
    return auth.user


CurrentSuperAdmin = Annotated[User, Depends(get_super_admin)]
CurrentProUser = Annotated[User, Depends(get_pro_user)]
