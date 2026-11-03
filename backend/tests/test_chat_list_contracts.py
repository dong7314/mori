from datetime import UTC, datetime, timedelta
from uuid import uuid4

from mori.chat.models import ChatTurn, Conversation


def make_conversation(session, user_id, title, at, *, message=None, answer=None, pinned=False):
    row = Conversation(user_id=user_id, title=title, pinned=pinned, created_at=at, updated_at=at)
    session.add(row)
    session.flush()
    if message is not None:
        session.add(
            ChatTurn(
                conversation_id=row.id,
                request_key=uuid4(),
                message=message,
                answer=answer,
                status="completed" if answer is not None else "running",
                durable=True,
                events=[],
                created_at=at + timedelta(minutes=1),
                deadline=at + timedelta(days=1),
            )
        )
    return str(row.id)


def test_conversation_list_has_latest_message_and_real_activity_time(client, accounts, sessions):
    older = datetime.now(UTC) - timedelta(days=2)
    newer = older + timedelta(days=1)
    with sessions.begin() as session:
        alice = accounts["alice"]["user_id"]
        old_id = make_conversation(
            session, alice, "이전 대화", older, message="오래된 질문", answer="오래된 답변"
        )
        new_id = make_conversation(session, alice, "어제 대화", newer, message="답변 대기 중")
        empty_id = make_conversation(session, alice, "빈 대화", older - timedelta(days=1))
        make_conversation(
            session, accounts["bob"]["user_id"], "다른 계정", newer, message="비공개 내용"
        )
    h = accounts["alice"]["headers"]
    changed = client.patch(
        "/v1/conversations/" + old_id, json={"revision": 1, "title": "이름 수정"}, headers=h
    )
    assert changed.status_code == 200, changed.text
    rows = client.get("/v1/conversations", headers=h).json()
    assert [row["id"] for row in rows] == [new_id, old_id, empty_id]
    assert [row["last_message"] for row in rows] == ["답변 대기 중", "오래된 답변", None]
    assert datetime.fromisoformat(rows[1]["last_activity_at"]) == older + timedelta(minutes=1)
    assert datetime.fromisoformat(rows[2]["last_activity_at"]) == older - timedelta(days=1)
    assert datetime.fromisoformat(rows[1]["updated_at"]) > newer

    pinned = client.patch(
        "/v1/conversations/" + old_id, json={"revision": 2, "pinned": True}, headers=h
    )
    assert pinned.status_code == 200
    rows = client.get("/v1/conversations", headers=h).json()
    assert [row["id"] for row in rows] == [old_id, new_id, empty_id]
    assert datetime.fromisoformat(rows[0]["last_activity_at"]) == older + timedelta(minutes=1)
    page = client.get("/v1/conversations", params={"offset": 1, "limit": 1}, headers=h).json()
    assert [row["id"] for row in page] == [new_id]
    assert client.get("/v1/conversations").status_code == 401


def test_conversation_search_returns_latest_preview_even_when_older_message_matches(
    client, accounts, sessions
):
    now = datetime.now(UTC)
    with sessions.begin() as session:
        cid = make_conversation(
            session,
            accounts["alice"]["user_id"],
            "기록",
            now - timedelta(days=1),
            message="처음 찾아볼 내용",
            answer="이전 답변",
        )
        session.add(
            ChatTurn(
                conversation_id=cid,
                request_key=uuid4(),
                message="최근 질문",
                answer="가장 최근 답변",
                status="completed",
                events=[],
                created_at=now,
                deadline=now,
            )
        )
    response = client.get(
        "/v1/conversations", params={"q": "찾아볼"}, headers=accounts["alice"]["headers"]
    )
    assert response.status_code == 200, response.text
    rows = response.json()
    assert len(rows) == 1 and rows[0]["id"] == cid
    assert rows[0]["last_message"] == "가장 최근 답변"
    assert datetime.fromisoformat(rows[0]["last_activity_at"]) == now
