"""Keep the shared protocol defenses after removing the standalone search endpoint."""

import asyncio

import httpx
import pytest

from mori.chat.protocol import check_toolsets, invocation, read_json
from mori.config import Settings
from mori.errors import ApiError


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"data": [None]},
        {"data": [{"name": "terminal", "enabled": True, "tools": ["terminal"]}]},
        {
            "data": [
                {
                    "name": "web",
                    "enabled": True,
                    "configured": False,
                    "tools": ["web_search", "web_extract"],
                }
            ]
        },
    ],
)
def test_invalid_or_unsafe_inventory_rejected(payload):
    with pytest.raises(ApiError):
        check_toolsets(payload)


@pytest.mark.parametrize(
    "status,body",
    [
        (401, "{}"),
        (302, "{}"),
        (500, "{}"),
        (429, "{}"),
        (200, "not json"),
        (200, "[]"),
        (200, "x" * 2_000_001),
    ],
    ids=[
        "unauthorized",
        "redirect",
        "server-error",
        "rate-limit",
        "invalid-json",
        "array",
        "too-large",
    ],
)
def test_preflight_rejects_bad_response_without_leaking_body(status, body):
    async def exercise():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(status, text=body))
        ) as client:
            with pytest.raises(ApiError) as error:
                await read_json(client, "GET", "http://hermes.test/v1/toolsets", {})
            assert error.value.message != body

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "args",
    [
        {"calls": [{"name": "terminal", "arguments": {}}]},
        {"calls": []},
        {"calls": "broken"},
    ],
)
def test_indirect_calls_cannot_hide_disallowed_tools(args):
    with pytest.raises(ValueError):
        invocation({"name": "tool_call", "arguments": args})


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp",
        "http://u:p@hermes",
        "http://hermes/v1",
        "http://hermes?q=x",
        "http://hermes#x",
    ],
)
def test_runtime_origin_validation_remains(url):
    with pytest.raises(ValueError):
        Settings(database_url="postgresql+psycopg://mori@localhost/mori", hermes_base_url=url)
