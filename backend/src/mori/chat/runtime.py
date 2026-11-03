from dataclasses import dataclass
from uuid import UUID

from pydantic import SecretStr

from mori.config import Settings
from mori.errors import ApiError


@dataclass(frozen=True)
class Runtime:
    url: str
    key: SecretStr
    user_id: UUID | None = None


def runtime_headers(runtime: Runtime) -> dict[str, str]:
    headers = {"Authorization": "Bearer " + runtime.key.get_secret_value()}
    if runtime.user_id is not None:
        headers["X-Mori-User-ID"] = str(runtime.user_id)
    return headers


def resolve_runtime(settings: Settings, user_id: UUID, tier: str, *, session=None) -> Runtime:
    if not settings.chat_enabled:
        raise ApiError(503, "CHAT_DISABLED", "채팅 기능이 아직 활성화되지 않았습니다.")
    if session is not None:
        from mori.auth.models import User
        from mori.billing.service import effective_tier

        user = session.get(User, user_id)
        if user is not None:
            tier = effective_tier(session, user)
    if session is not None and settings.runtime_provisioning_enabled and tier == "pro":
        from mori.runtimes.service import resolve_binding

        managed = resolve_binding(session, settings, user_id, tier)
        if managed is not None:
            return managed
    private = settings.chat_private_runtimes.get(str(user_id))
    if private and (tier == "pro" or not settings.shared_hermes_enabled):
        if tier != "pro":
            raise ApiError(403, "PRO_REQUIRED", "개인 에이전트 사용 승인이 필요합니다.")
        return Runtime(private.base_url, private.api_key)
    if settings.runtime_provisioning_enabled and tier == "pro":
        raise ApiError(503, "RUNTIME_NOT_READY", "개인 에이전트 환경을 준비하고 있습니다.")
    if settings.shared_hermes_enabled:
        # This URL must point to Mori's enforcing gateway, never the original shared API.
        return Runtime(settings.shared_hermes_base_url, settings.shared_hermes_api_key, user_id)
    # Shared profile memory is NOT isolated by conversation_history/store=False.
    # Until profile isolation exists, retain the existing single-owner experiment gate.
    if user_id != settings.hermes_test_user_id:
        raise ApiError(403, "CHAT_RUNTIME_REQUIRED", "사용 가능한 에이전트가 배정되지 않았습니다.")
    if not settings.hermes_base_url or not settings.hermes_api_key.get_secret_value():
        raise ApiError(503, "HERMES_NOT_CONFIGURED", "에이전트 연결이 설정되지 않았습니다.")
    return Runtime(settings.hermes_base_url, settings.hermes_api_key)
