from dataclasses import dataclass
from uuid import UUID

from pydantic import SecretStr

from mori.config import Settings
from mori.errors import ApiError


@dataclass(frozen=True)
class Runtime:
    url: str
    key: SecretStr


def resolve_runtime(settings: Settings, user_id: UUID, tier: str) -> Runtime:
    if not settings.chat_enabled:
        raise ApiError(503, "CHAT_DISABLED", "채팅 기능이 아직 활성화되지 않았습니다.")
    private = settings.chat_private_runtimes.get(str(user_id))
    if private:
        if tier != "pro":
            raise ApiError(403, "PRO_REQUIRED", "개인 에이전트 사용 승인이 필요합니다.")
        return Runtime(private.base_url, private.api_key)
    # Shared profile memory is NOT isolated by conversation_history/store=False.
    # Until profile isolation exists, retain the existing single-owner experiment gate.
    if user_id != settings.hermes_test_user_id:
        raise ApiError(403, "CHAT_RUNTIME_REQUIRED", "사용 가능한 에이전트가 배정되지 않았습니다.")
    if not settings.hermes_base_url or not settings.hermes_api_key.get_secret_value():
        raise ApiError(503, "HERMES_NOT_CONFIGURED", "에이전트 연결이 설정되지 않았습니다.")
    return Runtime(settings.hermes_base_url, settings.hermes_api_key)
