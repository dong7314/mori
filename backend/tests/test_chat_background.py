import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import func, select
from test_chat import SECRET, Agent, conversation

from mori.artifacts.models import DocumentJob
from mori.auth.models import User
from mori.chat import jobs, store
from mori.chat.models import ChatJob, ChatTurn
from mori.chat.router import observe
from mori.chat.schemas import Decision
from mori.config import PrivateRuntime
from mori.errors import ApiError
from mori.organizer.models import Reminder
from mori.parking.models import ParkingRecord


@pytest.fixture
def setup(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = settings.chat_worker_enabled = True
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.chat_stream_seconds = 0.02
    return settings, Agent()


def submit(client, accounts, cid, *, key=None, who="alice", message="내 주차 위치 알려줘"):
    return client.post(
        f"/v1/conversations/{cid}/runs",
        json={"message": message},
        headers={**accounts[who]["headers"], "Idempotency-Key": str(key or uuid4())},
    )


def exercise(sessions, settings, agent):
    return asyncio.run(jobs.run_chat_once(sessions, settings, transport=httpx.MockTransport(agent)))


def parking_decision():
    return Decision.model_validate_json(
        '{"action":"parking_save","parking":{"floor":"B3","spot":"B16"}}'
    )


def test_accept_disconnect_replay_and_background_completion(client, accounts, sessions, setup):
    settings, agent = setup
    cid, key = conversation(client, accounts), uuid4()
    response = submit(client, accounts, cid, key=key)
    assert response.status_code == 202
    run = UUID(response.json()["run_id"])
    assert submit(client, accounts, cid, key=key).json() == response.json()
    assert not agent.requests

    async def disconnect_observer():
        stream = observe(sessions, accounts["alice"]["user_id"], UUID(cid), run)
        assert "run.accepted" in await anext(stream)
        await stream.aclose()

    asyncio.run(disconnect_observer())
    with sessions.begin() as db:
        db.get(ChatTurn, run).deadline = datetime.now(UTC) - timedelta(hours=1)
    status = client.get(response.json()["status_url"], headers=accounts["alice"]["headers"])
    assert status.json()["status"] == "running" and status.json()["job_status"] == "queued"
    assert exercise(sessions, settings, agent)
    saved = client.get(response.json()["status_url"], headers=accounts["alice"]["headers"]).json()
    assert saved["status"] == saved["job_status"] == "completed"
    assert submit(client, accounts, cid, key=key).json() == response.json()
    assert not exercise(sessions, settings, agent)
    assert len(agent.requests) == 2
    replay = client.get(
        response.json()["events_url"],
        headers={**accounts["alice"]["headers"], "Last-Event-ID": f"{run}:1"},
    )
    assert "event: run.accepted" not in replay.text and "event: run.completed" in replay.text
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_sse_submission_is_only_an_observer(client, accounts, sessions, setup):
    settings, agent = setup
    cid = conversation(client, accounts)
    response = client.post(
        f"/v1/conversations/{cid}/messages",
        json={"message": "안녕"},
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 200 and "run.accepted" in response.text
    assert not agent.requests
    run = UUID(response.headers["x-mori-run-id"])
    assert (
        store.snapshot(sessions, accounts["alice"]["user_id"], UUID(cid), run)["job_status"]
        == "queued"
    )
    assert exercise(sessions, settings, agent)


def test_queue_is_owned_and_cancellation_fences_execution(client, accounts, sessions, setup):
    settings, _ = setup
    cid = conversation(client, accounts)
    accepted = submit(client, accounts, cid).json()
    run = UUID(accepted["run_id"])
    bob = accounts["bob"]["headers"]
    for suffix in ("", "/events"):
        assert client.get(accepted["status_url"] + suffix, headers=bob).status_code == 404
    assert client.post(accepted["status_url"] + "/cancel", headers=bob).status_code == 404
    claim = jobs.claim_next(sessions, settings)
    response = client.post(accepted["status_url"] + "/cancel", headers=accounts["alice"]["headers"])
    assert response.json()["job_status"] == "cancelled"
    with pytest.raises(ApiError, match="CHAT_LEASE_LOST"):
        store.finish(
            sessions, run, accounts["alice"]["user_id"], parking_decision(), lease_token=claim.token
        )
    assert (
        client.post(
            accepted["status_url"] + "/cancel", headers=accounts["alice"]["headers"]
        ).status_code
        == 200
    )
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 0


def test_concurrent_claim_and_expired_lease_cannot_duplicate_write(
    client, accounts, sessions, setup
):
    settings, _ = setup
    run = UUID(submit(client, accounts, conversation(client, accounts)).json()["run_id"])
    with ThreadPoolExecutor(max_workers=2) as executor:
        claims = list(executor.map(lambda _: jobs.claim_next(sessions, settings), range(2)))
    old = next(c for c in claims if c)
    assert len([c for c in claims if c]) == 1
    with sessions.begin() as db:
        db.get(ChatJob, run).lease_until = datetime.now(UTC) - timedelta(seconds=1)
    new = jobs.claim_next(sessions, settings)
    assert new.token != old.token
    with pytest.raises(ApiError):
        store.finish(sessions, run, old.user_id, parking_decision(), lease_token=old.token)
    store.finish(sessions, run, new.user_id, parking_decision(), lease_token=new.token)
    jobs.failed(sessions, old, "OLD_FAILURE")
    with sessions() as db:
        assert db.get(ChatJob, run).status == "completed"
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_transient_failure_is_durable_retry_then_one_result(client, accounts, sessions, setup):
    settings, agent = setup
    run = UUID(submit(client, accounts, conversation(client, accounts)).json()["run_id"])
    assert exercise(sessions, settings, lambda request: httpx.Response(503))
    with sessions.begin() as db:
        job = db.get(ChatJob, run)
        assert job.status == "retry" and job.attempts == 1
        job.available_at = datetime.now(UTC) - timedelta(seconds=1)
    assert exercise(sessions, settings, agent)
    with sessions() as db:
        assert db.get(ChatJob, run).status == "completed"
        assert db.get(ChatJob, run).attempts == 2
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 1


def test_final_crashed_attempt_is_closed_after_lease_expiry(client, accounts, sessions, setup):
    settings, _ = setup
    settings.chat_job_max_attempts = 1
    run = UUID(submit(client, accounts, conversation(client, accounts)).json()["run_id"])
    assert jobs.claim_next(sessions, settings)
    with sessions.begin() as db:
        db.get(ChatJob, run).lease_until = datetime.now(UTC) - timedelta(seconds=1)
    assert jobs.claim_next(sessions, settings) is None
    with sessions() as db:
        assert db.get(ChatTurn, run).status == db.get(ChatJob, run).status == "failed"


@pytest.mark.parametrize("invalid_reminder", [False, True])
def test_parking_and_reminder_commit_together(client, accounts, sessions, setup, invalid_reminder):
    settings, agent = setup
    target = datetime.now(UTC) + timedelta(hours=-1 if invalid_reminder else 1)
    agent.decision = {
        "action": "batch",
        "actions": [
            {"action": "parking_save", "parking": {"floor": "B3", "spot": "B16"}},
            {
                "action": "reminder_save",
                "reminder": {"title": "주차 위치 확인", "target_at": target.isoformat()},
            },
        ],
    }
    cid = conversation(client, accounts)
    run = UUID(submit(client, accounts, cid).json()["run_id"])
    assert exercise(sessions, settings, agent)
    saved = store.snapshot(sessions, accounts["alice"]["user_id"], UUID(cid), run)
    assert saved["status"] == ("failed" if invalid_reminder else "completed")
    with sessions() as db:
        expected = 0 if invalid_reminder else 1
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == expected
        assert db.scalar(select(func.count()).select_from(Reminder)) == expected
    if not invalid_reminder:
        assert len([e for e in saved["events"] if e["type"] == "action.completed"]) == 2
        assert "예약하지 않았어요" not in saved["answer"]


def test_pro_revoke_during_inference_prevents_publish(client, accounts, sessions, setup):
    settings, agent = setup
    user_id = accounts["alice"]["user_id"]
    settings.chat_private_runtimes[str(user_id)] = PrivateRuntime(
        base_url="http://private.test", api_key=SECRET
    )
    with sessions.begin() as db:
        db.get(User, user_id).tier = "pro"
    cid = conversation(client, accounts)
    run = UUID(submit(client, accounts, cid).json()["run_id"])

    def revoke(request):
        response = agent(request)
        if request.url.path == "/v1/responses":
            with sessions.begin() as db:
                db.get(User, user_id).tier = "free"
        return response

    assert exercise(sessions, settings, revoke)
    assert store.snapshot(sessions, user_id, UUID(cid), run)["status"] == "failed"
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ParkingRecord)) == 0


def test_batch_rejects_nested_duplicate_or_ambiguous_actions():
    valid = {"action": "note_save", "note": {"title": "메모"}}
    for other in (valid, {"action": "reply", "reply": "안녕"}, {"action": "parking_lookup"}):
        with pytest.raises(ValidationError):
            Decision.model_validate({"action": "batch", "actions": [valid, other]})


def test_worker_disabled_rejects_new_work_without_creating_job(client, accounts, sessions, setup):
    settings, _ = setup
    settings.chat_worker_enabled = False
    result = submit(client, accounts, conversation(client, accounts))
    assert result.status_code == 503 and result.json()["error"]["code"] == "CHAT_WORKER_DISABLED"
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(ChatJob)) == 0


def test_chat_document_work_is_queued_with_owned_result_link(client, accounts, sessions, setup):
    settings, agent = setup
    settings.documents_enabled = True
    agent.decision = {
        "action": "document_process",
        "document": {
            "operation": "create",
            "format": "docx",
            "spec": {"title": "회의록", "paragraphs": ["검토 내용"]},
        },
    }
    cid, key = conversation(client, accounts), uuid4()
    accepted = submit(client, accounts, cid, key=key).json()
    assert exercise(sessions, settings, agent)
    saved = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    event = next(e for e in saved["events"] if e["type"] == "action.queued")
    assert event["result_ref"]["kind"] == "document_job"
    assert not any(e["type"] == "action.completed" for e in saved["events"])
    job = client.get(event["result_ref"]["detail_url"], headers=accounts["alice"]["headers"])
    assert job.json()["status"] == "pending" and job.json()["output_file_id"] is None
    assert (
        client.get(
            event["result_ref"]["detail_url"], headers=accounts["bob"]["headers"]
        ).status_code
        == 404
    )
    submit(client, accounts, cid, key=key)
    assert not exercise(sessions, settings, agent)
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(DocumentJob)) == 1


def test_chat_document_cannot_read_another_users_file(client, accounts, sessions, setup):
    settings, agent = setup
    settings.documents_enabled = True
    upload = client.post(
        "/v1/files?filename=private.txt",
        content=b"BOB PRIVATE",
        headers={**accounts["bob"]["headers"], "Idempotency-Key": str(uuid4())},
    )
    assert upload.status_code == 201
    agent.decision = {
        "action": "document_process",
        "document": {"operation": "read", "source_file_id": upload.json()["id"]},
    }
    cid = conversation(client, accounts)
    accepted = submit(client, accounts, cid).json()
    assert exercise(sessions, settings, agent)
    saved = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    assert saved["status"] == "failed" and saved["events"][-1]["code"] == "FILE_NOT_FOUND"
    with sessions() as db:
        assert db.scalar(select(func.count()).select_from(DocumentJob)) == 0
    payload = str(agent.requests[-1].content)
    assert "private.txt" not in payload and "BOB PRIVATE" not in payload
