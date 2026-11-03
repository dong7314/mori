import asyncio
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from mori.artifacts.models import DocumentJob, StoredFile
from mori.artifacts.schemas import DocumentRequest
from mori.artifacts.service import run_document_once
from mori.chat.hermes import decision_from_response
from mori.errors import ApiError


def submit(client, accounts, payload, key):
    client.app.state.settings.documents_enabled = True
    return client.post(
        "/v1/document-jobs",
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key)},
    )


def assert_no_jobs_or_files(sessions):
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(DocumentJob)) == 0
        assert session.scalar(select(func.count()).select_from(StoredFile)) == 0


def assert_valid_retry(client, accounts, sessions, key):
    expected = "한글 😀\n탭\t끝\r\n리터럴 \\u0000"
    response = submit(
        client,
        accounts,
        {"operation": "create", "format": "txt", "spec": {"text": expected}},
        key,
    )
    assert response.status_code == 202, response.text
    assert asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + response.json()["id"],
        headers=accounts["alice"]["headers"],
    ).json()
    assert result["status"] == "completed", result
    output = client.get(
        "/v1/files/" + result["output_file_id"] + "/content",
        headers=accounts["alice"]["headers"],
    )
    assert output.content == expected.encode()


@pytest.mark.parametrize(
    ("format", "spec"),
    [
        ("txt", {"text": "before\x00after"}),
        ("docx", {"paragraphs": ["before\x00after"]}),
        ("xlsx", {"rows": [["before\x00after"]]}),
        ("docx", {"paragraphs": [{"nested\x00key": "value"}]}),
    ],
)
def test_document_spec_rejects_nested_nul_before_storage(client, accounts, sessions, format, spec):
    key = uuid4()
    response = submit(
        client, accounts, {"operation": "create", "format": format, "spec": spec}, key
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert_no_jobs_or_files(sessions)
    assert_valid_retry(client, accounts, sessions, key)


@pytest.mark.parametrize("number", ["1e1000", "-1e1000", "NaN", "Infinity", "-Infinity"])
def test_document_spec_rejects_nonfinite_json_before_storage(client, accounts, sessions, number):
    client.app.state.settings.documents_enabled = True
    key = uuid4()
    response = client.post(
        "/v1/document-jobs",
        content='{"operation":"create","format":"xlsx","spec":{"rows":[[' + number + "]]}}",
        headers={
            **accounts["alice"]["headers"],
            "Idempotency-Key": str(key),
            "Content-Type": "application/json",
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert_no_jobs_or_files(sessions)
    assert_valid_retry(client, accounts, sessions, key)


def test_document_spec_keeps_other_control_validation_in_worker(client, accounts, sessions):
    response = submit(
        client,
        accounts,
        {"operation": "create", "format": "txt", "spec": {"text": "before\x01after"}},
        uuid4(),
    )
    assert response.status_code == 202, response.text
    assert asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + response.json()["id"],
        headers=accounts["alice"]["headers"],
    ).json()
    assert result["status"] == "failed", result
    assert result["error_code"] == "DOCUMENT_PROCESSING_FAILED"
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(StoredFile)) == 0


def raw_request(depth, kind):
    value = (
        ("[" * depth + "0" + "]" * depth)
        if kind == "list"
        else ('{"a":' * depth + "0" + "}" * depth)
    )
    return '{"operation":"create","format":"txt","spec":{"text":' + value + "}}"


@pytest.mark.parametrize("kind", ["list", "dict"])
@pytest.mark.parametrize("depth", [255, 300])
def test_deep_spec_returns_validation_error_before_jobs(client, accounts, sessions, depth, kind):
    client.app.state.settings.documents_enabled = True
    key = str(uuid4())
    with TestClient(client.app, raise_server_exceptions=False) as bounded_client:
        response = bounded_client.post(
            "/v1/document-jobs",
            content=raw_request(depth, kind),
            headers={
                **accounts["alice"]["headers"],
                "Content-Type": "application/json",
                "Idempotency-Key": key,
            },
        )
        assert response.status_code == 422, (response.status_code, response.text)
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert_no_jobs_or_files(sessions)
    assert_valid_retry(client, accounts, sessions, key)


@pytest.mark.parametrize("kind", ["list", "dict"])
def test_spec_serialization_boundary_still_accepted(client, accounts, sessions, kind):
    client.app.state.settings.documents_enabled = True
    raw = raw_request(254, kind)
    # Validate the raw JSON using the same JSON parser as HTTP before Pydantic,
    # whose model_validate_json has a different independent JSON depth limit.
    model = DocumentRequest.model_validate(json.loads(raw))
    expected = model.model_dump(mode="json")
    key = str(uuid4())
    headers = {
        **accounts["alice"]["headers"],
        "Content-Type": "application/json",
        "Idempotency-Key": key,
    }
    response = client.post("/v1/document-jobs", content=raw, headers=headers)
    assert response.status_code == 202, response.text
    replay = client.post("/v1/document-jobs", content=raw, headers=headers)
    assert replay.status_code == 202, replay.text
    assert replay.json()["id"] == response.json()["id"]
    with sessions() as session:
        row = session.get(DocumentJob, response.json()["id"])
        assert row.spec == expected["spec"]
    # The shape remains unsupported by the TXT engine. Its existing asynchronous
    # validation still reports a failed job instead of the API adding a new rule.
    assert asyncio.run(run_document_once(sessions, client.app.state.settings))
    result = client.get(
        "/v1/document-jobs/" + response.json()["id"],
        headers=accounts["alice"]["headers"],
    ).json()
    assert result["status"] == "failed", result
    assert result["error_code"] == "DOCUMENT_PROCESSING_FAILED"


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("depth", [190, 255])
def test_agent_document_json_depth_is_classified(batch, depth):
    document = raw_request(depth, "list")
    action = '{"action":"document_process","document":' + document + "}"
    if batch:
        action = (
            '{"action":"batch","actions":['
            + action
            + ',{"action":"note_save","note":{"title":"정상","body":"메모"}}]}'
        )
    response = {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": action}],
            }
        ],
    }
    if depth == 255:
        with pytest.raises(ApiError) as rejected:
            decision_from_response(response)
        assert rejected.value.code == "INVALID_AGENT_RESPONSE"
    else:
        decision = decision_from_response(response)
        inner = decision.actions[0].document if batch else decision.document
        assert inner.model_dump(mode="json")["operation"] == "create"
