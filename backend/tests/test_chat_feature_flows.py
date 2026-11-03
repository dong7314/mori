import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from test_chat import agent as agent
from test_chat import conversation, events, send
from test_feature_contracts import create

from mori.chat import store
from mori.chat.schemas import Decision
from mori.features.models import Feature, FeatureResult, SkillVersion
from mori.organizer.models import Note


@pytest.mark.parametrize("status", ["active", "paused", "draft"])
def test_chat_repeated_feature_title_returns_existing_definition_and_detail(
    client, accounts, sessions, agent, status
):
    headers = accounts["alice"]["headers"]
    original = create(
        client,
        accounts,
        {
            "title": "퇴근 정리",
            "work": "" if status == "draft" else "오늘 메모 정리",
            "reference": "보존할 참고 내용",
            "allowed_actions": ["reply", "note_save"],
            "schedule": {"time": "19:00", "repeat": "weekdays"},
        },
    ).json()
    path = "/v1/features/" + original["id"]
    if status == "paused":
        original = client.post(
            path + "/state", json={"revision": 1, "status": "paused"}, headers=headers
        ).json()
    agent.decision = {
        "action": "feature_save",
        "feature": {"title": "퇴근 정리", "work": "새로운 내용으로 덮어쓰려는 제안"},
    }
    cid, key = conversation(client, accounts), uuid4()
    observed = events(send(client, accounts, cid, "퇴근 정리 기능 만들어줘", key=key))
    assert observed[-1]["type"] == "run.completed", observed
    result = next(event for event in observed if event["type"] == "action.completed")
    assert result["result_ref"] == {
        "resource_id": original["id"],
        "kind": "feature",
        "detail_url": path,
    }
    assert "이미 ‘퇴근 정리’ 기능이 있어요" in observed[-2]["text"]
    assert client.get(path, headers=headers).json() == original
    assert events(send(client, accounts, cid, "퇴근 정리 기능 만들어줘", key=key)) == observed
    messages = client.get(f"/v1/conversations/{cid}/messages", headers=headers).json()
    assert messages[0]["result_refs"] == [result["result_ref"]]
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Feature)) == 1
        assert session.scalar(select(func.count()).select_from(SkillVersion)) == 1
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


def test_chat_feature_title_reuse_excludes_deleted_and_other_user_features(
    client, accounts, sessions, agent
):
    deleted = create(client, accounts, {"title": "정리", "work": "삭제된 기능"}).json()
    with sessions.begin() as session:
        session.get(Feature, UUID(deleted["id"])).deleted_at = datetime.now(UTC)
    foreign = client.post(
        "/v1/features",
        json={"title": "정리", "work": "다른 사용자 기능"},
        headers={**accounts["bob"]["headers"], "Idempotency-Key": str(uuid4())},
    ).json()
    agent.decision = {"action": "feature_save", "feature": {"title": "정리", "work": "내 기능"}}
    observed = events(send(client, accounts, conversation(client, accounts), "정리 기능 만들어줘"))
    result = next(event["result"] for event in observed if event["type"] == "action.completed")
    assert result["id"] not in {deleted["id"], foreign["id"]}
    assert result["work"] == "내 기능"
    # Duplicate form titles remain a supported choice; only chat creation reuses them.
    second_form = create(client, accounts, {"title": "정리", "work": "두 번째 폼"}).json()
    assert second_form["id"] != result["id"]


def test_concurrent_chat_feature_creation_reuses_one_record(sessions, accounts):
    user_id = accounts["alice"]["user_id"]
    decision = Decision(action="feature_save", feature={"title": "정리", "work": "메모 정리"})

    def save():
        with sessions.begin() as session:
            return store.perform_action(session, uuid4(), user_id, decision, uuid4())[1]["id"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        ids = list(executor.map(lambda _: save(), range(2)))
    assert len(set(ids)) == 1
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(Feature)) == 1


def test_today_feature_context_includes_note_saved_today_after_old_creation(
    client, accounts, sessions, agent
):
    headers = accounts["alice"]["headers"]
    notes = []
    for title in ("오늘 고친 메모", "어제 그대로인 메모"):
        notes.append(
            client.post(
                "/v1/notes",
                json={"title": title, "body": "예전 내용"},
                headers={**headers, "Idempotency-Key": str(uuid4())},
            ).json()
        )
    old = datetime.now(UTC) - timedelta(days=2)
    with sessions.begin() as session:
        for note in notes:
            row = session.get(Note, UUID(note["id"]))
            row.created_at = row.updated_at = old
    edited = client.put(
        "/v1/notes/" + notes[0]["id"],
        json={"revision": 1, "title": notes[0]["title"], "body": "오늘 저장한 내용"},
        headers=headers,
    )
    assert edited.status_code == 200, edited.text
    feature = create(client, accounts, {"work": "오늘 저장한 메모를 모아서 정리"}).json()
    cid = conversation(client, accounts)
    agent.decision = {"action": "reply", "reply": "- 오늘 고친 메모"}
    observed = events(
        client.post(
            f"/v1/conversations/{cid}/messages",
            json={"message": "지금 실행", "feature_id": feature["id"]},
            headers={**headers, "Idempotency-Key": str(uuid4())},
        )
    )
    assert observed[-1]["type"] == "run.completed", observed
    payload = json.loads(next(r.content for r in agent.requests if r.url.path == "/v1/responses"))
    context = json.loads(payload["instructions"].split("Mori 사용자 문맥(JSON 데이터):\n", 1)[1])
    assert context["today_notes"] == [
        {"id": notes[0]["id"], "title": "오늘 고친 메모", "body": "오늘 저장한 내용"}
    ]


@pytest.mark.parametrize("status", ["active", "paused", "draft"])
def test_chat_feature_lookup_returns_state_and_detail_without_running_or_resuming(
    client, accounts, sessions, agent, status
):
    headers = accounts["alice"]["headers"]
    original = create(
        client, accounts, {"title": "퇴근 정리", "work": "" if status == "draft" else "정리"}
    ).json()
    path = "/v1/features/" + original["id"]
    if status == "paused":
        original = client.post(
            path + "/state", json={"revision": 1, "status": "paused"}, headers=headers
        ).json()
    create(client, accounts, {"builtin_key": "news", "title": "뉴스", "work": "AI"})
    agent.decision = {"action": "feature_lookup", "feature_id": original["id"]}
    cid = conversation(client, accounts)
    observed = events(send(client, accounts, cid, "퇴근 정리 확인해줘"))
    assert observed[-1]["type"] == "run.completed", observed
    result = next(event for event in observed if event["type"] == "action.completed")
    assert result["result"] == {
        "id": original["id"],
        "title": original["title"],
        "status": status,
        "version": 1,
    }
    assert result["result_ref"] == {
        "resource_id": original["id"],
        "kind": "feature",
        "detail_url": path,
    }
    assert client.get(path, headers=headers).json() == original
    messages = client.get(f"/v1/conversations/{cid}/messages", headers=headers).json()
    assert messages[0]["result_refs"] == [result["result_ref"]]
    payload = json.loads(next(r.content for r in agent.requests if r.url.path == "/v1/responses"))
    context = json.loads(payload["instructions"].split("Mori 사용자 문맥(JSON 데이터):\n", 1)[1])
    assert [(f["id"], f["status"]) for f in context["features"]] == [(original["id"], status)]
    assert context["context_limits"]["features_truncated"] is False
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0


@pytest.mark.parametrize("change", ["deleted", "owner", "builtin"])
def test_feature_lookup_rechecks_owned_undeleted_custom_after_model_context(
    client, accounts, sessions, agent, monkeypatch, change
):
    from mori.chat import router

    original = create(client, accounts, {"title": "정리", "work": "정리"}).json()

    async def model(client, runtime, settings, message, history, context):
        assert original["id"] in [f["id"] for f in json.loads(context)["features"]]
        with sessions.begin() as session:
            row = session.get(Feature, UUID(original["id"]))
            if change == "deleted":
                row.deleted_at = datetime.now(UTC)
            elif change == "owner":
                row.user_id = accounts["bob"]["user_id"]
            else:
                row.builtin_key = "news"
        yield Decision(action="feature_lookup", feature_id=UUID(original["id"]))

    monkeypatch.setattr(router, "interpret", model)
    observed = events(send(client, accounts, conversation(client, accounts), "정리 상태 확인"))
    assert observed[-1]["type"] == "run.failed", observed
    assert observed[-1]["code"] in {"FEATURE_NOT_FOUND", "RESOURCE_NOT_FOUND"}
    assert not any(event.get("result_ref") for event in observed)


def test_feature_lookup_cannot_guess_id_outside_bounded_context(client, accounts, sessions, agent):
    with sessions.begin() as session:
        session.add_all(
            Feature(
                id=UUID(int=index),
                user_id=accounts["alice"]["user_id"],
                title=f"기능 {index}",
                description="",
                work="정리",
                reference="",
                icon="spark",
                status="active",
            )
            for index in range(1, 52)
        )
    agent.decision = {"action": "feature_lookup", "feature_id": str(UUID(int=51))}
    observed = events(send(client, accounts, conversation(client, accounts), "기능 51 확인"))
    assert observed[-1]["type"] == "run.failed", observed
    assert observed[-1]["code"] == "FEATURE_NOT_FOUND"
    payload = json.loads(next(r.content for r in agent.requests if r.url.path == "/v1/responses"))
    context = json.loads(payload["instructions"].split("Mori 사용자 문맥(JSON 데이터):\n", 1)[1])
    assert len(context["features"]) == 50
    assert str(UUID(int=51)) not in [f["id"] for f in context["features"]]
    assert context["context_limits"]["features_truncated"] is True


def test_custom_execution_cannot_invoke_feature_lookup(client, accounts, sessions, agent):
    original = create(client, accounts, {"work": "정리"}).json()
    agent.decision = {"action": "feature_lookup", "feature_id": original["id"]}
    cid = conversation(client, accounts)
    observed = events(
        client.post(
            f"/v1/conversations/{cid}/messages",
            json={"message": "실행", "feature_id": original["id"]},
            headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
        )
    )
    assert observed[-1]["type"] == "run.failed", observed
    assert observed[-1]["code"] == "FEATURE_ACTION_NOT_ALLOWED"
    with sessions() as session:
        assert session.scalar(select(func.count()).select_from(FeatureResult)) == 0
