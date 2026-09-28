import asyncio
import json
from uuid import uuid4

import httpx
import pytest

from mori.assistant.evidence import NOTICE, parse_response
from mori.assistant.hermes import get_hermes_client, search
from mori.config import Settings
from mori.errors import ApiError

URL = "https://example.org/visit"
SECRET = "hermes-secret-must-not-leak"


def evidence(bridge=False):
    def call(name, args, cid):
        if bridge:
            args, name = {"calls": [{"name": name, "arguments": args}]}, "tool_call"
        return {
            "type": "function_call",
            "call_id": cid,
            "name": name,
            "arguments": json.dumps(args),
        }

    return {
        "status": "completed",
        "output": [
            call("web_search", {"query": "관람시간"}, "search"),
            {
                "type": "function_call_output",
                "call_id": "search",
                "output": json.dumps(
                    {"success": True, "data": {"web": [{"url": URL, "title": "관람 안내"}]}}
                ),
            },
            call("web_extract", {"urls": [URL]}, "extract"),
            {
                "type": "function_call_output",
                "call_id": "extract",
                "output": json.dumps(
                    {
                        "results": [
                            {"url": URL, "title": "관람 안내", "content": "관람시간 10시부터 18시"}
                        ]
                    }
                ),
            },
            {
                "type": "message",
                "role": "assistant",
                "phase": "commentary",
                "content": [{"type": "output_text", "text": "조사 중"}],
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "10시부터 18시입니다. 출처: " + URL}],
            },
        ],
    }


class Stub:
    def __init__(self):
        self.calls = []
        self.payload = evidence()
        self.failure = None
        self.toolsets = {
            "data": [
                {
                    "name": "web",
                    "enabled": True,
                    "configured": True,
                    "tools": ["web_search", "web_extract"],
                }
            ]
        }

    def __call__(self, request):
        self.calls.append(request)
        assert request.headers["Authorization"] == "Bearer " + SECRET
        assert "X-Hermes-Session-Key" not in request.headers
        if self.failure == "timeout":
            raise httpx.ReadTimeout(SECRET, request=request)
        if self.failure == "network":
            raise httpx.ConnectError(SECRET, request=request)
        if request.url.path == "/v1/toolsets":
            return httpx.Response(200, json=self.toolsets)
        assert request.url.path == "/v1/responses"
        if isinstance(self.failure, int):
            return httpx.Response(
                self.failure, text=SECRET, headers={"Location": "https://evil.test"}
            )
        if self.failure == "json":
            return httpx.Response(200, text=SECRET)
        if self.failure == "large":
            return httpx.Response(200, content=b"x" * 2_000_001)
        return httpx.Response(200, json=self.payload)


@pytest.fixture
def hermes_stub(client, accounts):
    settings = client.app.state.settings
    settings.hermes_base_url = "http://hermes.test"
    from pydantic import SecretStr

    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    stub = Stub()

    async def override():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(stub), follow_redirects=False
        ) as c:
            yield c

    client.app.dependency_overrides[get_hermes_client] = override
    return stub


def post(client, accounts, **kwargs):
    return client.post(
        "/v1/assistant/search",
        headers=accounts["alice"]["headers"],
        json=kwargs or {"message": "관람시간을 찾아줘"},
    )


def test_authenticated_search_preserves_evidence_and_keeps_credentials_private(
    client, accounts, hermes_stub
):
    response = post(client, accounts)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["sources"] == [{"title": "관람 안내", "url": URL, "evidence": "extract"}]
    assert [t["name"] for t in data["tools"]] == ["web_search", "web_extract"]
    assert "조사 중" not in data["answer"]
    assert SECRET not in response.text
    assert response.headers["cache-control"] == "no-store"
    body = json.loads(hermes_stub.calls[-1].content)
    assert set(body) == {"input", "instructions", "store", "stream"}
    assert body["store"] is False and body["stream"] is False
    assert accounts["alice"]["headers"]["Authorization"] not in str(hermes_stub.calls[-1].headers)
    again = post(client, accounts)
    assert again.json()["request_id"] != data["request_id"]


def test_unauthenticated_and_other_user_never_call_hermes(client, accounts, hermes_stub):
    assert client.post("/v1/assistant/search", json={"message": "hello"}).status_code == 401
    other = client.post(
        "/v1/assistant/search", headers=accounts["bob"]["headers"], json={"message": "hello"}
    )
    assert other.status_code == 403
    assert not hermes_stub.calls


def test_disabled_by_default(client, accounts):
    response = post(client, accounts)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "HERMES_NOT_CONFIGURED"


@pytest.mark.parametrize(
    "body",
    [
        {"message": " "},
        {"message": "x" * 4001},
        {"message": "\u0000"},
        {"message": "hello", "user_id": str(uuid4())},
        {"message": "hello", "previous_response_id": "other-user"},
        {"message": "hello", "instructions": "override"},
        {"message": "hello", "hermes_url": "http://evil.test"},
    ],
)
def test_request_cannot_override_identity_or_agent_context(client, accounts, hermes_stub, body):
    assert post(client, accounts, **body).status_code == 422
    assert not hermes_stub.calls


@pytest.mark.parametrize(
    ("failure", "status", "code"),
    [
        ("timeout", 504, "HERMES_TIMEOUT"),
        ("network", 503, "HERMES_UNAVAILABLE"),
        (429, 503, "HERMES_UNAVAILABLE"),
        (500, 503, "HERMES_UNAVAILABLE"),
        (401, 502, "HERMES_UPSTREAM_ERROR"),
        (302, 502, "HERMES_UPSTREAM_ERROR"),
        ("json", 502, "HERMES_INVALID_RESPONSE"),
        ("large", 502, "HERMES_INVALID_RESPONSE"),
    ],
)
def test_upstream_failures_are_sanitized_and_not_retried(
    client, accounts, hermes_stub, failure, status, code
):
    hermes_stub.failure = failure
    response = post(client, accounts)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert SECRET not in response.text
    assert len(hermes_stub.calls) <= 2


def test_unsafe_tool_configuration_stops_before_generation(client, accounts, hermes_stub):
    hermes_stub.toolsets["data"].append(
        {"name": "terminal", "enabled": True, "configured": True, "tools": ["terminal"]}
    )
    response = post(client, accounts)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "HERMES_TOOL_POLICY_MISMATCH"
    assert len(hermes_stub.calls) == 1


def test_missing_search_tools_stop_before_generation(client, accounts, hermes_stub):
    hermes_stub.toolsets["data"][0]["configured"] = False
    assert post(client, accounts).json()["error"]["code"] == "HERMES_TOOLS_UNAVAILABLE"
    assert len(hermes_stub.calls) == 1


@pytest.mark.parametrize("bridge", [False, True])
def test_direct_and_indirect_wrapped_evidence(bridge):
    payload = evidence(bridge)
    for i in (1, 3):
        source = "tool_call" if bridge else ("web_search" if i == 1 else "web_extract")
        payload["output"][i]["output"] = (
            f'<untrusted_tool_result source="{source}">\n'
            + NOTICE
            + payload["output"][i]["output"]
            + "\n</untrusted_tool_result>"
        )
    assert len(parse_response(payload, uuid4()).tools) == 2


@pytest.mark.parametrize(
    "mutation",
    [
        "wrong_id",
        "duplicate_id",
        "missing",
        "reversed",
        "failed",
        "empty",
        "prose_only",
        "not_completed",
        "unsafe_tool",
        "malformed",
    ],
)
def test_false_success_is_rejected(mutation):
    p = evidence()
    if mutation == "wrong_id":
        p["output"][1]["call_id"] = "other"
    if mutation == "duplicate_id":
        p["output"][2]["call_id"] = "search"
    if mutation == "missing":
        del p["output"][1]
    if mutation == "reversed":
        p["output"][0:2] = reversed(p["output"][0:2])
    if mutation == "failed":
        p["output"][1]["output"] = '{"success":false,"error":"blocked"}'
    if mutation == "empty":
        p["output"][1]["output"] = '{"success":true,"data":{"web":[]}}'
    if mutation == "prose_only":
        p["output"] = p["output"][-1:]
    if mutation == "not_completed":
        p["status"] = "failed"
    if mutation == "unsafe_tool":
        p["output"][0]["name"] = "terminal"
    if mutation == "malformed":
        p["output"][1]["output"] = 'prefix {"success":true}'
    with pytest.raises(ApiError):
        parse_response(p, uuid4())


def test_partial_extract_failure_is_reported_without_fake_extract_source():
    p = evidence()
    p["output"][3]["output"] = json.dumps({"results": [{"url": URL, "error": "blocked"}]})
    r = parse_response(p, uuid4())
    assert r.sources[0].evidence == "search"
    assert r.tools[1].status == "failed"


def test_total_deadline_includes_slow_upstream():
    settings = Settings(database_url="postgresql+psycopg://mori@localhost/mori")
    settings.hermes_base_url = "http://hermes.test"
    # Short test-only deadline; production validation requires >=10 seconds.
    settings.hermes_timeout_seconds = 0.01

    async def exercise():
        async def slow(request):
            await asyncio.sleep(1)
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
            with pytest.raises(ApiError) as error:
                await search(client, settings, "hello", uuid4())
            assert error.value.code == "HERMES_TIMEOUT"

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp",
        "http://u:p@hermes",
        "http://hermes/v1",
        "http://hermes?q=x",
        "http://hermes#x",
        "http://hermes/\nx",
    ],
)
def test_invalid_server_origins_rejected(url):
    with pytest.raises(ValueError):
        Settings(database_url="postgresql+psycopg://mori@localhost/mori", hermes_base_url=url)


def test_openapi_assistant_contract(client):
    schema = client.get("/openapi.json").json()
    op = schema["paths"]["/v1/assistant/search"]["post"]
    assert op["security"] == [{"HTTPBearer": []}]
    assert set(op["responses"]) == {"200", "401", "403", "422", "502", "503", "504"}
    assert schema["components"]["schemas"]["SearchRequest"]["additionalProperties"] is False


LAB_TOKEN = "mori_lab_" + "a" * 64


def enable_test_token(client):
    from pydantic import SecretStr

    settings = client.app.state.settings
    settings.assistant_test_token_enabled = True
    settings.assistant_test_token = SecretStr(LAB_TOKEN)
    settings.hermes_test_user_id = None


def test_temporary_token_bypasses_login_without_creating_user(
    client, accounts, hermes_stub, sessions
):
    from sqlalchemy import func, select

    from mori.auth.models import User

    enable_test_token(client)
    with sessions() as db:
        before = db.scalar(select(func.count()).select_from(User))
    response = client.post(
        "/v1/assistant/search",
        headers={"Authorization": "Bearer " + LAB_TOKEN},
        json={"message": "공식 관람시간을 찾아줘"},
    )
    assert response.status_code == 200, response.text
    assert LAB_TOKEN not in response.text
    assert LAB_TOKEN not in str(hermes_stub.calls[-1].headers)
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(User)) == before


@pytest.mark.parametrize("case", ["wrong", "disabled", "unicode", "long", "missing", "basic"])
def test_test_token_failures_never_call_hermes(client, accounts, hermes_stub, case):
    enable_test_token(client)
    token = LAB_TOKEN
    if case == "wrong":
        token = "mori_lab_" + "b" * 64
    elif case == "disabled":
        client.app.state.settings.assistant_test_token_enabled = False
    elif case == "unicode":
        # HTTP headers are ASCII; a direct dependency call covers non-ASCII defenses below.
        token = "mori_lab_" + "%" * 64
    elif case == "long":
        token += "x" * 300
    headers = {"Authorization": ("Basic " if case == "basic" else "Bearer ") + token}
    if case == "missing":
        headers = {}
    response = client.post("/v1/assistant/search", headers=headers, json={"message": "hello"})
    assert response.status_code == 401
    assert not hermes_stub.calls


@pytest.mark.parametrize("path", ["/v1/me", "/v1/parking-records/latest"])
def test_temporary_token_does_not_bypass_other_api_auth(client, accounts, hermes_stub, path):
    enable_test_token(client)
    response = client.get(path, headers={"Authorization": "Bearer " + LAB_TOKEN})
    assert response.status_code == 401
    assert not hermes_stub.calls


def test_temporary_token_does_not_query_auth_database(monkeypatch):
    from fastapi.testclient import TestClient

    from mori.main import create_app

    settings = Settings(
        database_url="postgresql+psycopg://mori@127.0.0.1:1/unavailable",
        hermes_base_url="http://hermes.test",
        hermes_api_key=SECRET,
        assistant_test_token_enabled=True,
        assistant_test_token=LAB_TOKEN,
    )
    stub = Stub()

    async def override():
        async with httpx.AsyncClient(transport=httpx.MockTransport(stub)) as c:
            yield c

    app = create_app(settings)
    app.dependency_overrides[get_hermes_client] = override
    with TestClient(app) as client:
        response = client.post(
            "/v1/assistant/search",
            headers={"Authorization": "Bearer " + LAB_TOKEN},
            json={"message": "hello"},
        )
        assert response.status_code == 200, response.text
        client.app.state.settings.assistant_test_token_enabled = False
        assert (
            client.post(
                "/v1/assistant/search",
                headers={"Authorization": "Bearer " + LAB_TOKEN},
                json={"message": "hello"},
            ).status_code
            == 401
        )


@pytest.mark.parametrize("token", ["", "short", "mori_lab_" + "한" * 64, "mori_lab_" + "x" * 63])
def test_enabling_test_auth_requires_strong_generated_token(token):
    with pytest.raises(ValueError):
        Settings(
            database_url="postgresql+psycopg://mori@localhost/mori",
            assistant_test_token_enabled=True,
            assistant_test_token=token,
        )
