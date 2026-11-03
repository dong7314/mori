"""Explicit permissions fence model-suggested writes in both execution paths."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from functools import partial
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select

from mori.artifacts.models import DocumentJob
from mori.auth.models import User
from mori.automation.models import AutomationJob
from mori.automation.scheduler import claim_job, complete_job, enqueue_due, run_once
from mori.chat import store
from mori.chat.models import ChatTurn, Conversation
from mori.chat.runtime import resolve_runtime
from mori.chat.schemas import Decision
from mori.errors import ApiError
from mori.features.models import Feature, FeatureResult, SkillVersion
from mori.features.schemas import FeatureCreate, FeatureUpdate
from mori.features.service import create_feature, update_feature
from mori.organizer.models import Note, Reminder


def runtime(settings, accounts):
    settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("feature-test-key")
    return settings


def feature(sessions, accounts, actions=None, *, scheduled=False):
    now = datetime.now(UTC)
    with sessions.begin() as session:
        row = create_feature(
            session,
            accounts["alice"]["user_id"],
            FeatureCreate(
                title="할 일 정리",
                work="할 일을 메모로 저장하고 알림을 등록해 줘",
                allowed_actions=actions or ["reply"],
                schedule={
                    "repeat": "once",
                    "time": now.strftime("%H:%M"),
                    "date": now.date(),
                    "timezone": "UTC",
                }
                if scheduled
                else None,
            ),
        )
        if scheduled:
            row.updated_at = now.replace(second=0, microsecond=0) - timedelta(seconds=1)
        return row.id


def turn(sessions, accounts, feature_id):
    user_id = accounts["alice"]["user_id"]
    with sessions.begin() as session:
        conversation = Conversation(user_id=user_id, title="기능 실행")
        session.add(conversation)
        session.flush()
        conversation_id = conversation.id
    run_id, _, _ = store.claim(
        sessions, user_id, conversation_id, uuid4(), "실행해 줘", 300, feature_id
    )
    return run_id


def note():
    return Decision(action="note_save", note={"title": "회의 준비", "body": "안건 정리"})


def note_and_reminder():
    return Decision(
        action="batch",
        actions=[
            note(),
            Decision(
                action="reminder_save",
                reminder={
                    "title": "회의 준비",
                    "target_at": datetime.now(UTC) + timedelta(hours=1),
                },
            ),
        ],
    )


def document(source_file_id=None):
    return Decision(
        action="document_process",
        document=(
            {"operation": "read", "source_file_id": source_file_id}
            if source_file_id
            else {
                "operation": "create",
                "format": "docx",
                "spec": {"title": "정리", "paragraphs": ["회의 안건"]},
            }
        ),
    )


def scheduled_claim(sessions, accounts, actions):
    fid = feature(sessions, accounts, actions, scheduled=True)
    assert enqueue_due(sessions) == 1
    claim = claim_job(sessions)
    assert claim and claim.feature_id == fid
    return claim


def count(session, model):
    return session.scalar(select(func.count()).select_from(model))


def test_api_permissions_are_explicit_owned_and_versioned(client, sessions, accounts):
    headers = accounts["alice"]["headers"]
    response = client.post(
        "/v1/features",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={"title": "정리", "work": "메모로 저장"},
    )
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["allowed_actions"] == ["reply"]
    updated = client.put(
        f"/v1/features/{row['id']}",
        headers=headers,
        json={
            "revision": 1,
            "title": "정리",
            "work": "메모로 저장",
            "allowed_actions": ["reply", "note_save"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["version"] == 2
    assert updated.json()["allowed_actions"] == ["reply", "note_save"]
    assert client.get(f"/v1/features/{row['id']}/versions/1", headers=headers).json()[
        "allowed_actions"
    ] == ["reply"]
    assert (
        client.put(
            f"/v1/features/{row['id']}",
            headers=accounts["bob"]["headers"],
            json={
                "revision": 2,
                "allowed_actions": ["reply", "document_process"],
            },
        ).status_code
        == 404
    )
    with sessions() as session:
        saved = session.get(SkillVersion, (UUID(row["id"]), 2))
        assert saved.definition["allowed_actions"] == ["reply", "note_save"]


@pytest.mark.parametrize(
    "actions",
    [
        [],
        ["note_save"],
        ["reply", "reply"],
        ["reply", "feature_save"],
        ["reply", "feature_run"],
        ["reply", "http_request"],
    ],
)
def test_api_cannot_grant_unbounded_or_recursive_actions(client, accounts, actions):
    response = client.post(
        "/v1/features",
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
        json={"allowed_actions": actions},
    )
    assert response.status_code == 422


def test_model_cannot_self_grant_future_write_permissions(sessions, accounts):
    decision = Decision(
        action="feature_save",
        feature={
            "title": "임의 권한",
            "work": "메모 저장",
            "allowed_actions": ["reply", "note_save"],
        },
    )
    with pytest.raises(ApiError) as exc:
        with sessions.begin() as session:
            store.perform_action(session, uuid4(), accounts["alice"]["user_id"], decision, uuid4())
    assert exc.value.code == "FEATURE_POLICY_REQUIRES_CONFIRMATION"
    with sessions() as session:
        assert count(session, Feature) == 0


@pytest.mark.parametrize("scheduled", [False, True])
def test_default_readonly_denies_writes_before_any_side_effect(
    sessions, accounts, settings, scheduled
):
    runtime(settings, accounts)
    if scheduled:
        claim = scheduled_claim(sessions, accounts, ["reply"])
        invoke = partial(complete_job, sessions, claim, note(), settings=settings)
    else:
        run_id = turn(sessions, accounts, feature(sessions, accounts))
        invoke = partial(
            store.finish, sessions, run_id, accounts["alice"]["user_id"], note(), settings=settings
        )
    with pytest.raises(ApiError) as exc:
        invoke()
    assert exc.value.code == "FEATURE_ACTION_NOT_ALLOWED"
    with sessions() as session:
        assert count(session, Note) == count(session, FeatureResult) == 0


@pytest.mark.parametrize("scheduled", [False, True])
def test_permitted_batch_commits_evidence_and_result_once(sessions, accounts, settings, scheduled):
    runtime(settings, accounts)
    actions = ["reply", "note_save", "reminder_save"]
    if scheduled:
        claim = scheduled_claim(sessions, accounts, actions)
        run_id = claim.run_id
        assert complete_job(
            sessions,
            claim,
            note_and_reminder(),
            settings=settings,
            runtime_url=settings.hermes_base_url,
        )
        assert not complete_job(sessions, claim, note_and_reminder(), settings=settings)
    else:
        run_id = turn(sessions, accounts, feature(sessions, accounts, actions))
        store.finish(
            sessions, run_id, accounts["alice"]["user_id"], note_and_reminder(), settings=settings
        )
        with pytest.raises(ApiError) as exc:
            store.finish(
                sessions,
                run_id,
                accounts["alice"]["user_id"],
                note_and_reminder(),
                settings=settings,
            )
        assert exc.value.code == "RUN_ENDED"
    with sessions() as session:
        assert (
            count(session, Note) == count(session, Reminder) == count(session, FeatureResult) == 1
        )
        row = session.get(ChatTurn, run_id)
        evidence = [e for e in row.events if e["type"] == "action.completed"]
        assert [e["action"] for e in evidence] == ["note_save", "reminder_save"]
        assert evidence[0]["result_ref"]["detail_url"].startswith("/v1/notes/")
        assert evidence[1]["result_ref"]["detail_url"].startswith("/v1/reminders/")
        assert row.answer.startswith("메모를 저장했어요.\n알림 목표를 저장했어요.")
        assert row.status == "completed"


@pytest.mark.parametrize("scheduled", [False, True])
def test_batch_second_action_failure_rolls_back_first_write(
    sessions, accounts, settings, scheduled
):
    runtime(settings, accounts)
    settings.documents_enabled = True
    actions = ["reply", "note_save", "document_process"]
    decision = Decision(action="batch", actions=[note(), document(uuid4())])
    if scheduled:
        claim = scheduled_claim(sessions, accounts, actions)
        run_id = claim.run_id
        invoke = partial(complete_job, sessions, claim, decision, settings=settings)
    else:
        run_id = turn(sessions, accounts, feature(sessions, accounts, actions))
        invoke = partial(
            store.finish,
            sessions,
            run_id,
            accounts["alice"]["user_id"],
            decision,
            settings=settings,
        )
    with pytest.raises(ApiError) as exc:
        invoke()
    assert exc.value.code == "FILE_NOT_FOUND"
    with sessions() as session:
        assert (
            count(session, Note)
            == count(session, DocumentJob)
            == count(session, FeatureResult)
            == 0
        )
        row = session.get(ChatTurn, run_id)
        assert row.status == "running"
        assert not any(e["type"].startswith("action.") for e in row.events)
        if scheduled:
            assert session.get(AutomationJob, claim.id).status == "running"


def test_scheduled_documents_are_queued_and_not_reported_as_completed(sessions, accounts, settings):
    runtime(settings, accounts)
    settings.documents_enabled = True
    claim = scheduled_claim(sessions, accounts, ["reply", "document_process"])
    assert complete_job(sessions, claim, document(), settings=settings)
    with sessions() as session:
        job = session.scalar(select(DocumentJob))
        assert job.status == "pending" and job.output_file_id is None
        assert job.request_key == claim.run_id
        row = session.get(ChatTurn, claim.run_id)
        queued = [e for e in row.events if e["type"] == "action.queued"]
        assert len(queued) == 1 and queued[0]["result_ref"]["kind"] == "document_job"
        assert not any(e["type"] == "action.completed" for e in row.events)
        assert "등록했어요" in row.answer


@pytest.mark.parametrize("scheduled", [False, True])
def test_editing_permissions_during_execution_fences_old_version(
    sessions, accounts, settings, scheduled
):
    runtime(settings, accounts)
    if scheduled:
        claim = scheduled_claim(sessions, accounts, ["reply", "note_save"])
        fid, run_id = claim.feature_id, claim.run_id
    else:
        fid = feature(sessions, accounts, ["reply", "note_save"])
        run_id = turn(sessions, accounts, fid)
    with sessions.begin() as session:
        row = session.get(Feature, fid)
        update_feature(
            session,
            accounts["alice"]["user_id"],
            fid,
            FeatureUpdate(
                revision=row.revision,
                title=row.title,
                work=row.work,
                schedule=row.schedule,
                allowed_actions=["reply"],
            ),
        )
    if scheduled:
        assert not complete_job(sessions, claim, note(), settings=settings)
    else:
        with pytest.raises(ApiError) as exc:
            store.finish(sessions, run_id, accounts["alice"]["user_id"], note(), settings=settings)
        assert exc.value.code == "FEATURE_CHANGED"
    with sessions() as session:
        assert count(session, Note) == count(session, FeatureResult) == 0


@pytest.mark.parametrize("scheduled", [False, True])
def test_pro_revocation_after_inference_denies_domain_publication(
    sessions, accounts, settings, scheduled
):
    runtime(settings, accounts)
    user_id = accounts["alice"]["user_id"]
    from mori.config import PrivateRuntime

    settings.chat_private_runtimes = {
        str(user_id): PrivateRuntime(
            base_url="http://private.test", api_key=SecretStr("private-key")
        )
    }
    with sessions.begin() as session:
        session.get(User, user_id).tier = "pro"
    if scheduled:
        claim = scheduled_claim(sessions, accounts, ["reply", "note_save"])
        invoke = partial(
            complete_job,
            sessions,
            claim,
            note(),
            settings=settings,
            runtime_url="http://private.test",
        )
    else:
        run_id = turn(sessions, accounts, feature(sessions, accounts, ["reply", "note_save"]))
        invoke = partial(
            store.finish,
            sessions,
            run_id,
            user_id,
            note(),
            settings=settings,
            runtime_url="http://private.test",
        )
    with sessions() as session:
        assert (
            resolve_runtime(settings, user_id, "pro", session=session).url == "http://private.test"
        )
    with sessions.begin() as session:
        session.get(User, user_id).tier = "free"
    with pytest.raises(ApiError) as exc:
        invoke()
    assert exc.value.code == "PRO_REQUIRED"
    with sessions() as session:
        assert count(session, Note) == count(session, FeatureResult) == 0


def test_scheduled_model_execution_uses_persisted_permissions(
    sessions, accounts, settings, monkeypatch
):
    runtime(settings, accounts)
    settings.automation_enabled = True
    feature(sessions, accounts, ["reply", "note_save"], scheduled=True)
    seen = []

    async def model(client, target, configuration, message, history, context):
        seen.append(json.loads(context)["selected_feature"]["allowed_actions"])
        yield note()

    monkeypatch.setattr("mori.automation.scheduler.interpret", model)
    assert asyncio.run(
        run_once(
            sessions, settings, transport=httpx.MockTransport(lambda request: httpx.Response(500))
        )
    )
    assert seen == [["reply", "note_save"]]
    with sessions() as session:
        assert session.scalar(select(AutomationJob)).status == "completed"
        assert count(session, Note) == 1


def test_scheduler_rechecks_pro_access_after_model_returns(
    sessions, accounts, settings, monkeypatch
):
    from mori.config import PrivateRuntime

    runtime(settings, accounts)
    settings.automation_enabled = True
    user_id = accounts["alice"]["user_id"]
    settings.chat_private_runtimes = {
        str(user_id): PrivateRuntime(
            base_url="http://private.test", api_key=SecretStr("private-key")
        )
    }
    with sessions.begin() as session:
        session.get(User, user_id).tier = "pro"
    feature(sessions, accounts, ["reply", "note_save"], scheduled=True)

    async def model(client, target, configuration, message, history, context):
        assert target.url == "http://private.test"
        with sessions.begin() as session:
            session.get(User, user_id).tier = "free"
        yield note()

    monkeypatch.setattr("mori.automation.scheduler.interpret", model)
    assert asyncio.run(run_once(sessions, settings))
    with sessions() as session:
        job = session.scalar(select(AutomationJob))
        assert job.status == "pending" and job.error_code == "PRO_REQUIRED"
        assert count(session, Note) == count(session, FeatureResult) == 0
        turn = session.get(ChatTurn, job.run_id)
        assert turn.status == "running"
        assert turn.events[-1]["type"] == "run.retrying"
