from uuid import uuid4

from fastapi import APIRouter, Request

from mori.assistant.auth import SearchCaller
from mori.assistant.hermes import HermesClient, search
from mori.assistant.schemas import SearchRequest, SearchResponse
from mori.database import DatabaseSession
from mori.errors import ApiError, ErrorResponse

router = APIRouter(prefix="/v1/assistant", tags=["assistant"])


@router.post(
    "/search",
    response_model=SearchResponse,
    summary="테스트용 웹 검색 및 본문 기반 답변",
    description=(
        "지정된 소셜 로그인 계정 또는 명시적으로 활성화한 임시 검색 토큰을 사용합니다. "
        "임시 토큰은 이 API에만 적용되며 사용자 계정을 생성하거나 "
        "다른 API 인증을 우회하지 않습니다."
    ),
    responses={code: {"model": ErrorResponse} for code in (401, 403, 422, 502, 503, 504)},
)
async def search_web(
    payload: SearchRequest,
    caller: SearchCaller,
    session: DatabaseSession,
    request: Request,
    hermes: HermesClient,
) -> SearchResponse:
    settings = request.app.state.settings
    if (
        not settings.hermes_base_url
        or not settings.hermes_api_key.get_secret_value()
        or (not caller.test_token and not settings.hermes_test_user_id)
    ):
        raise ApiError(503, "HERMES_NOT_CONFIGURED", "에이전트 연결이 설정되지 않았습니다.")
    if not caller.test_token and caller.user_id != settings.hermes_test_user_id:
        raise ApiError(
            403, "ASSISTANT_TEST_ACCESS_REQUIRED", "현재 지정된 테스트 계정만 사용할 수 있습니다."
        )
    # Authentication opened a DB transaction; don't hold its connection during LLM inference.
    session.rollback()
    return await search(hermes, settings, payload.message, uuid4())
