"""Internal Hermes protocol checks used by the chat stream, not a public search API."""

import json

import httpx

from mori.errors import ApiError

TOOLS = {"web_search", "web_extract", "mori_image_search"}


def invalid_response() -> ApiError:
    return ApiError(502, "HERMES_INVALID_RESPONSE", "에이전트 응답을 확인할 수 없습니다.")


def object_value(value) -> dict:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError("Expected object")
    return value


def invocation(item: dict) -> tuple[str, dict] | None:
    name = item.get("name")
    if name == "tool_describe":
        return None
    args = object_value(item.get("arguments", {}))
    if name == "tool_call":
        calls = args.get("calls", [{"name": args.get("name"), "arguments": args.get("arguments")}])
        if isinstance(calls, str):
            calls = json.loads(calls)
        if isinstance(calls, dict):
            calls = [calls]
        if not isinstance(calls, list) or len(calls) != 1:
            raise ValueError("Unsupported batched tool evidence")
        entry = object_value(calls[0])
        name = entry.get("name")
        args = object_value(entry.get("arguments", {}))
    if name not in TOOLS:
        raise ValueError("Unexpected tool executed")
    return name, args


async def read_json(
    client: httpx.AsyncClient, method: str, url: str, headers: dict, **kwargs
) -> dict:
    async with client.stream(method, url, headers=headers, **kwargs) as response:
        if response.status_code == 429 or response.status_code >= 500:
            raise ApiError(503, "HERMES_UNAVAILABLE", "에이전트가 요청을 처리할 수 없습니다.")
        if response.status_code != 200:
            raise ApiError(502, "HERMES_UPSTREAM_ERROR", "에이전트 연결 설정을 확인해 주세요.")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > 2_000_000:
                raise invalid_response()
        try:
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError("Expected object")
            return result
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise invalid_response() from exc


def check_toolsets(payload: dict) -> None:
    """Configuration smoke check, not an execution sandbox or MCP inventory guarantee."""
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise invalid_response()
    available = set()
    for row in rows:
        if not isinstance(row, dict):
            raise invalid_response()
        if row.get("enabled") is True:
            names = row.get("tools")
            if (
                row.get("name") not in ("web", "mori_images")
                or not isinstance(names, list)
                or any(n not in ("web_search", "web_extract", "mori_image_search") for n in names)
            ):
                raise ApiError(
                    503,
                    "HERMES_TOOL_POLICY_MISMATCH",
                    "테스트용 에이전트의 도구 설정을 확인해 주세요.",
                )
            if row.get("configured") is True:
                available.update(names)
    if not {"web_search", "web_extract"}.issubset(available):
        raise ApiError(
            503, "HERMES_TOOLS_UNAVAILABLE", "검색·본문 추출 도구가 준비되지 않았습니다."
        )
