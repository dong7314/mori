import asyncio
import io
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from docx import Document as Word
from pydantic import SecretStr
from test_artifacts import upload
from test_chat import SECRET, Agent, conversation

from mori.artifacts.models import StoredFile
from mori.chat import jobs
from mori.organizer.models import Document


@pytest.fixture
def configured(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = settings.chat_worker_enabled = settings.documents_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    agent = Agent()
    agent.decision = {"action": "reply", "reply": "Attached document summary."}
    return settings, agent


def submit(client, accounts, cid, refs, key=None):
    return client.post(
        f"/v1/conversations/{cid}/runs",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key or uuid4())},
        json={"message": "Summarize the attached documents.", "attachments": refs},
    )


def execute(sessions, settings, agent):
    asyncio.run(jobs.run_chat_once(sessions, settings, transport=httpx.MockTransport(agent)))


def test_explicit_old_file_and_text_document_are_read_without_recent_history(
    client, accounts, sessions, configured
):
    settings, agent = configured
    word = Word()
    word.add_paragraph("Explicit original content")
    body = io.BytesIO()
    word.save(body)
    file = upload(client, accounts, "old.docx", body.getvalue()).json()
    for i in range(11):
        upload(client, accounts, f"other-{i}.txt", b"recent unrelated")
    with sessions.begin() as db:
        text = Document(
            user_id=accounts["alice"]["user_id"],
            title="Older text",
            filename="old.txt",
            text="Text document evidence",
        )
        db.add(text)
        db.flush()
        text_id = str(text.id)
        db.add(
            Document(
                user_id=accounts["bob"]["user_id"],
                title="Private",
                filename="private.txt",
                text="BOB_PRIVATE_CONTENT",
            )
        )
    refs = [{"kind": "file", "id": file["id"]}, {"kind": "document", "id": text_id}]
    cid, key = conversation(client, accounts), uuid4()
    accepted = submit(client, accounts, cid, refs, key)
    assert accepted.status_code == 202, accepted.text
    assert submit(client, accounts, cid, refs, key).json() == accepted.json()
    assert submit(client, accounts, cid, refs[:1], key).status_code == 409
    execute(sessions, settings, agent)
    payload = json.loads(agent.requests[-1].content)
    context = json.loads(payload["instructions"].split("Mori 사용자 문맥(JSON 데이터):\n", 1)[1])
    assert len(context["attachments"]) == 2
    assert "Explicit original content" in context["attachments"][0]["extracted_data_preview"]
    assert "Text document evidence" in context["attachments"][1]["extracted_data_preview"]
    assert file["id"] not in [item["id"] for item in context["files"]]
    assert "BOB_PRIVATE_CONTENT" not in payload["instructions"]
    state = client.get(accepted.json()["status_url"], headers=accounts["alice"]["headers"]).json()
    assert state["status"] == "completed" and state["attachments"] == refs
    assert [e["type"] for e in state["events"]].count("attachment.completed") == 2
    messages = client.get(
        f"/v1/conversations/{cid}/messages", headers=accounts["alice"]["headers"]
    ).json()
    assert messages[-1]["attachments"] == refs


def test_foreign_deleted_duplicate_and_too_many_attachments_rejected(client, accounts, configured):
    foreign = upload(client, accounts, "private.txt", b"private", user="bob").json()
    own = upload(client, accounts, "own.txt", b"mine").json()
    cid = conversation(client, accounts)
    assert submit(client, accounts, cid, [{"kind": "file", "id": foreign["id"]}]).status_code == 404
    ref = {"kind": "file", "id": own["id"]}
    assert submit(client, accounts, cid, [ref, ref]).status_code == 422
    assert (
        submit(
            client, accounts, cid, [{"kind": "file", "id": str(uuid4())} for _ in range(4)]
        ).status_code
        == 422
    )
    client.delete("/v1/files/" + own["id"], headers=accounts["alice"]["headers"])
    assert submit(client, accounts, cid, [ref]).status_code == 404


def test_unreadable_attachment_fails_before_model(client, accounts, sessions, configured):
    settings, agent = configured
    file = upload(client, accounts, "bad.pdf", b"not a pdf").json()
    accepted = submit(
        client, accounts, conversation(client, accounts), [{"kind": "file", "id": file["id"]}]
    ).json()
    execute(sessions, settings, agent)
    state = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    assert state["status"] == "failed"
    assert state["events"][-1]["code"] == "ATTACHMENT_UNREADABLE"
    assert not agent.requests


def test_attachment_deleted_during_model_call_cannot_publish_answer(
    client, accounts, sessions, configured
):
    settings, agent = configured
    file = upload(client, accounts, "data.txt", b"owned evidence").json()
    accepted = submit(
        client, accounts, conversation(client, accounts), [{"kind": "file", "id": file["id"]}]
    ).json()

    def delete_then_answer(request):
        if request.url.path == "/v1/responses":
            with sessions.begin() as db:
                db.get(StoredFile, UUID(file["id"])).deleted_at = datetime.now(UTC)
        return agent(request)

    execute(sessions, settings, delete_then_answer)
    state = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    assert state["status"] == "failed" and state["answer"] is None
    assert state["events"][-1]["code"] == "FILE_NOT_FOUND"


def test_cancel_during_attachment_read_stops_model(
    client, accounts, sessions, configured, monkeypatch
):
    settings, agent = configured
    file = upload(client, accounts, "data.txt", b"owned evidence").json()
    cid = conversation(client, accounts)
    accepted = submit(client, accounts, cid, [{"kind": "file", "id": file["id"]}]).json()

    def extract(*args):
        jobs.cancel(sessions, accounts["alice"]["user_id"], UUID(cid), UUID(accepted["run_id"]))
        return {"text": "must not reach the model"}

    monkeypatch.setattr("mori.chat.attachments.extract_file", extract)
    execute(sessions, settings, agent)
    state = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    assert state["job_status"] == "cancelled" and state["answer"] is None
    assert not agent.requests
