from enum import StrEnum


class AccountTier(StrEnum):
    FREE = "free"
    PRO = "pro"


class AccountRole(StrEnum):
    USER = "user"
    SUPER_ADMIN = "super_admin"


class AccessAction(StrEnum):
    APPROVE_PRO = "approve_pro"
    REVOKE_PRO = "revoke_pro"
    GRANT_SUPER_ADMIN = "grant_super_admin"
    REVOKE_SUPER_ADMIN = "revoke_super_admin"
