import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select

from mori.auth.models import User
from mori.chat import store
from mori.chat.models import ChatTurn
from mori.chat.router import get_chat_transport, work
from mori.chat.runtime import resolve_runtime
from mori.config import PrivateRuntime
from mori.parking.models import ParkingRecord

SECRET = "never-expose-hermes-key"


def completed(decision):
    return {
        "type": "response.completed",
        "response": {
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": json.dumps(decision, ensure_ascii=False)}
                    ],
                }
            ],
        },
    }


class Agent:
    def __init__(self):
        self.requests = []
        self.prefix = []
        self.decision = {
            "action": "parking_save",
            "parking": {"floor": "B3", "spot": "B16"},
            "reminder_requested": True,
        }
        self.broken = False

    def __call__(self, request):
        self.requests.append(request)
        assert request.headers["authorization"] == "Bearer " + SECRET
        if request.url.path == "/v1/toolsets":
            assert request.extensions["timeout"]["read"] == 90
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "name": "web",
                            "enabled": True,
                            "configured": True,
                            "tools": ["web_search", "web_extract"],
                        }
                    ]
                },
            )
        payload = json.loads(request.content)
        assert payload["stream"] is True and payload["store"] is False
        events = self.prefix + [completed(self.decision)]
        body = "".join("data: " + json.dumps(e) + "\n\n" for e in events)
        if self.broken:
            body = body.rstrip()  # No final frame delimiter.
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})


@pytest.fixture
def agent(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = True
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    agent = Agent()
    client.app.dependency_overrides[get_chat_transport] = lambda: httpx.MockTransport(agent)
    return agent


def conversation(client, accounts, who="alice"):
    response = client.post("/v1/conversations", headers=accounts[who]["headers"], json={})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def send(
    client, accounts, cid, message="지하 3층 B16에 주차했어. 내일 알려줘", key=None, who="alice"
):
    return client.post(
        f"/v1/conversations/{cid}/messages",
        json={"message": message},
        headers={**accounts[who]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def events(response):
    assert response.status_code == 200, response.text
    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def test_save_replay_and_snapshot_are_atomic_and_owned(client, accounts, agent, sessions):
    cid, key = conversation(client, accounts), uuid4()
    response = send(client, accounts, cid, key=key)
    observed = events(response)
    assert [e["type"] for e in observed] == [
        "run.accepted",
        "runtime.connecting",
        "runtime.ready",
        "action.started",
        "action.completed",
        "capability.unavailable",
        "message.completed",
        "run.completed",
    ]
    assert "예약하지 않았어요" in observed[-2]["text"]
    assert SECRET not in response.text
    assert events(send(client, accounts, cid, key=key)) == observed
    assert len(agent.requests) == 2  # A retry does not execute the agent again.
    assert send(client, accounts, cid, message="다른 요청", key=key).status_code == 409
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 1
        record = db.scalar(select(ParkingRecord))
        assert record.user_id == accounts["alice"]["user_id"] and record.spot == "B16"
    path = f"/v1/conversations/{cid}/runs/{response.headers['x-mori-run-id']}"
    assert client.get(path, headers=accounts["alice"]["headers"]).json()["status"] == "completed"
    assert client.get(path, headers=accounts["bob"]["headers"]).status_code == 404
    assert send(client, accounts, cid, who="bob").status_code == 404
    assert client.get("/v1/conversations", headers=accounts["bob"]["headers"]).json() == []
    assert (
        client.get(
            f"/v1/conversations/{cid}/messages", headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )


def test_lookup_history_and_filtering_actual_tool_events(client, accounts, agent):
    cid = conversation(client, accounts)
    send(client, accounts, cid)
    agent.decision = {"action": "parking_lookup"}
    agent.prefix = [
        {"type": "response.reasoning_text.delta", "delta": "PRIVATE_REASONING"},
        {"type": "response.output_text.delta", "delta": "PRIVATE_PLANNER"},
        {
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "call_id": "c1",
                "name": "tool_call",
                "arguments": json.dumps(
                    {"calls": [{"name": "web_search", "arguments": {"query": "PRIVATE_QUERY"}}]}
                ),
            },
        },
        {
            "type": "response.output_item.done",
            "item": {"type": "function_call_output", "call_id": "c1", "output": "PRIVATE_RESULT"},
        },
    ]
    response = send(client, accounts, cid, message="내 차 어디야?")
    observed = events(response)
    assert "B16" in observed[-2]["text"]
    assert "PRIVATE_" not in response.text
    assert [e["type"] for e in observed if e["type"].startswith("tool.")] == [
        "tool.started",
        "tool.returned",
    ]
    body = json.loads(agent.requests[-1].content)
    assert len(body["conversation_history"]) == 2
    assert "예약하지 않았어요" in body["conversation_history"][1]["content"]


@pytest.mark.parametrize("failure", ["truncated", "invalid", "missing_result", "unsafe"])
def test_bad_stream_never_saves(client, accounts, agent, sessions, failure):
    if failure == "truncated":
        agent.broken = True
    elif failure == "invalid":
        agent.decision["parking"] = {"floor": "B3", "user_id": str(uuid4())}
    else:
        agent.prefix = [
            {
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "call_id": "x",
                    "name": "terminal" if failure == "unsafe" else "web_search",
                    "arguments": '{"query":"hi"}',
                },
            }
        ]
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.failed"
    assert all(e["type"] != "action.completed" for e in observed)
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 0


def test_parking_rolls_back_if_terminal_evidence_cannot_commit(
    client, accounts, agent, sessions, monkeypatch
):
    original = store.append

    def broken(turn, kind, **data):
        if kind == "message.completed":
            raise RuntimeError(SECRET)
        return original(turn, kind, **data)

    monkeypatch.setattr(store, "append", broken)
    response = send(client, accounts, conversation(client, accounts))
    assert events(response)[-1]["type"] == "run.failed"
    assert SECRET not in response.text
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 0


def test_private_runtime_requires_pro_and_does_not_fall_back(client, accounts, agent, sessions):
    cid = conversation(client, accounts, "bob")
    assert send(client, accounts, cid, who="bob").status_code == 403
    settings = client.app.state.settings
    settings.chat_private_runtimes[str(accounts["bob"]["user_id"])] = PrivateRuntime(
        base_url="http://private-bob.test", api_key=SECRET
    )
    assert send(client, accounts, cid, who="bob").status_code == 403
    with sessions.begin() as db:
        db.get(User, accounts["bob"]["user_id"]).tier = "pro"
    agent.decision = {"action": "parking_lookup"}
    observed = events(send(client, accounts, cid, message="주차 위치?", who="bob"))
    assert "아직 저장한 주차 위치가 없어요" in observed[-2]["text"]
    assert agent.requests[-1].url.host == "private-bob.test"


def test_auth_and_flag(client, accounts, agent):
    cid = conversation(client, accounts)
    client.app.state.settings.chat_enabled = False
    assert send(client, accounts, cid).status_code == 503
    assert client.post("/v1/conversations", json={}).status_code == 401
    assert (
        client.post(
            "/v1/conversations", json={}, headers={"Authorization": "Bearer mori_lab_" + "a" * 64}
        ).status_code
        == 401
    )
    assert not agent.requests


def test_active_run_exclusion_and_expiry(client, accounts, agent, sessions):
    cid = UUID(conversation(client, accounts))
    key = uuid4()
    run, _, _ = store.claim(sessions, accounts["alice"]["user_id"], cid, key, "hello", 300)
    assert send(client, accounts, cid).status_code == 409
    with sessions.begin() as db:
        db.get(ChatTurn, run).deadline = datetime.now(UTC) - timedelta(seconds=1)
    path = f"/v1/conversations/{cid}/runs/{run}"
    assert client.get(path, headers=accounts["alice"]["headers"]).json()["status"] == "interrupted"
    assert events(send(client, accounts, cid))[-1]["type"] == "run.completed"


def test_disconnect_before_action_marks_interrupted(client, accounts, agent, sessions):
    cid = UUID(conversation(client, accounts))
    uid = accounts["alice"]["user_id"]
    run, _, history = store.claim(sessions, uid, cid, uuid4(), "hello", 300)
    settings = client.app.state.settings

    async def exercise():
        stream = work(
            sessions,
            run,
            uid,
            settings,
            resolve_runtime(settings, uid, "free"),
            httpx.MockTransport(agent),
            "hello",
            history,
        )
        await anext(stream)
        await stream.aclose()

    asyncio.run(exercise())
    assert store.snapshot(sessions, uid, cid, run)["status"] == "interrupted"
    assert not agent.requests


def test_cold_start_timeout_is_terminal_without_side_effect(client, accounts, agent, sessions):
    settings = client.app.state.settings
    settings.hermes_timeout_seconds = 0.01

    async def slow(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    client.app.dependency_overrides[get_chat_transport] = lambda: httpx.MockTransport(slow)
    observed = events(send(client, accounts, conversation(client, accounts)))
    assert observed[-1]["type"] == "run.failed"
    assert observed[-1]["code"] == "HERMES_TIMEOUT"
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 0


def test_disconnect_after_commit_preserves_completion_for_replay(client, accounts, agent, sessions):
    cid = UUID(conversation(client, accounts))
    uid, key = accounts["alice"]["user_id"], uuid4()
    message = "지하 3층 B16에 주차했어. 내일 알려줘"
    run, _, history = store.claim(sessions, uid, cid, key, message, 300)
    settings = client.app.state.settings

    async def exercise():
        stream = work(
            sessions,
            run,
            uid,
            settings,
            resolve_runtime(settings, uid, "free"),
            httpx.MockTransport(agent),
            message,
            history,
        )
        async for event in stream:
            if event["type"] == "action.completed":
                break  # Disconnect before the final message is delivered.
        await stream.aclose()

    asyncio.run(exercise())
    saved = store.snapshot(sessions, uid, cid, run)
    assert saved["status"] == "completed"
    assert saved["events"][-1]["type"] == "run.completed"
    before = len(agent.requests)
    assert events(send(client, accounts, cid, key=key)) == saved["events"]
    assert len(agent.requests) == before
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 1


@pytest.mark.parametrize("message", ["\u0000", " ", "x" * 4001])
def test_invalid_input_stops_before_agent(client, accounts, agent, message):
    cid = conversation(client, accounts)
    assert send(client, accounts, cid, message=message).status_code == 422
    assert not agent.requests


def test_removed_search_api_and_bypass_are_not_exposed(client, accounts, agent):
    schema = client.get("/openapi.json").json()
    assert "/v1/assistant/search" not in schema["paths"]
    assert "SearchRequest" not in schema["components"]["schemas"]
    for headers in (
        {},
        accounts["alice"]["headers"],
        {"Authorization": "Bearer mori_lab_" + "a" * 64},
    ):
        assert (
            client.post(
                "/v1/assistant/search", headers=headers, json={"message": "검색해줘"}
            ).status_code
            == 404
        )
    assert not agent.requests


@pytest.mark.parametrize("use_search", [False, True])
def test_same_chat_endpoint_supports_reply_with_or_without_search(
    client, accounts, agent, use_search
):
    agent.decision = {
        "action": "reply",
        "reply": "공식 안내: https://example.org" if use_search else "안녕하세요!",
    }
    if use_search:
        agent.prefix = [
            {
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "call_id": "search-1",
                    "name": "web_search",
                    "arguments": '{"query":"서울 관광 공식 안내"}',
                },
            },
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call_output",
                    "call_id": "search-1",
                    "output": '{"success":true,"data":{"web":[{"url":"https://example.org"}]}}',
                },
            },
        ]
    response = send(
        client,
        accounts,
        conversation(client, accounts),
        message="서울 관광 공식 안내 찾아줘" if use_search else "안녕",
    )
    observed = events(response)
    assert observed[-1]["type"] == "run.completed"
    assert observed[-2]["text"] == agent.decision["reply"]
    assert any(e["type"] == "tool.started" for e in observed) == use_search
    assert not any(e["type"].startswith("action.") for e in observed)
    assert json.loads(agent.requests[-1].content)["input"] == (
        "서울 관광 공식 안내 찾아줘" if use_search else "안녕"
    )
