import asyncio
import contextlib
import json
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.chat import store
from mori.chat.context import execution_context
from mori.chat.hermes import interpret
from mori.chat.models import ChatTurn, Conversation
from mori.chat.runtime import resolve_runtime
from mori.chat.schemas import (
    ChatMessage,
    ConversationCreate,
    ConversationRead,
    ConversationUpdate,
    Decision,
)
from mori.database import DatabaseSession
from mori.errors import ApiError
from mori.organizer.service import check_revision

router = APIRouter(prefix="/v1/conversations", tags=["chat"])


def get_chat_transport():
    return None


def frame(event):
    return (
        f"id: {event['run_id']}:{event['id']}\nevent: {event['type']}\n"
        f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    )


@router.post("", response_model=ConversationRead, status_code=201)
def create_conversation(payload: ConversationCreate, user: CurrentUser, session: DatabaseSession):
    row = Conversation(user_id=user.id, title=payload.title)
    session.add(row)
    session.commit()
    return row


@router.get("", response_model=list[ConversationRead])
def list_conversations(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
    q: str = Query("", max_length=200),
):
    return list(
        session.scalars(
            select(Conversation)
            .where(
                Conversation.user_id == user.id,
                Conversation.deleted_at.is_(None),
                Conversation.title.icontains(q, autoescape=True)
                | select(ChatTurn.id)
                .where(
                    ChatTurn.conversation_id == Conversation.id,
                    ChatTurn.message.icontains(q, autoescape=True)
                    | ChatTurn.answer.icontains(q, autoescape=True),
                )
                .exists(),
            )
            .order_by(
                Conversation.pinned.desc(), Conversation.updated_at.desc(), Conversation.id.desc()
            )
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/{conversation_id}/messages")
def list_messages(
    conversation_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    store.owned(session, conversation_id, user.id)
    turns = list(
        session.scalars(
            select(ChatTurn)
            .where(ChatTurn.conversation_id == conversation_id)
            .order_by(ChatTurn.created_at.desc(), ChatTurn.id.desc())
            .offset(offset)
            .limit(limit)
            .with_for_update()
        )
    )
    for turn in turns:
        store.expire(turn)
    session.commit()
    return [
        {
            "run_id": t.id,
            "message": t.message,
            "answer": t.answer,
            "status": t.status,
            "created_at": t.created_at,
            "result_refs": [e["result_ref"] for e in t.events if e.get("result_ref")],
        }
        for t in reversed(turns)
    ]


@router.get("/{conversation_id}/runs/{run_id}")
async def get_run(
    conversation_id: UUID,
    run_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    user_id = user.id
    session.rollback()
    return await asyncio.to_thread(
        store.snapshot, request.app.state.session_factory, user_id, conversation_id, run_id
    )


async def work(factory, run_id, user_id, settings, runtime, transport, message, history):
    try:
        yield {
            "id": 1,
            "type": "run.accepted",
            "run_id": str(run_id),
            "message": "요청을 받았어요.",
        }
        yield await asyncio.to_thread(
            store.progress,
            factory,
            run_id,
            "runtime.connecting",
            message="모리에게 연결하고 있어요. 잠들어 있다면 깨울게요.",
        )
        async with asyncio.timeout(settings.hermes_timeout_seconds):
            async with httpx.AsyncClient(
                transport=transport, trust_env=False, follow_redirects=False
            ) as client:
                # At most one selection round followed by the pinned skill execution.
                for attempt in range(2):
                    context = await asyncio.to_thread(execution_context, factory, user_id, run_id)
                    selected = False
                    async with contextlib.aclosing(
                        interpret(client, runtime, settings, message, history, context)
                    ) as updates:
                        async for item in updates:
                            if isinstance(item, Decision) and item.action == "feature_run":
                                if attempt:
                                    raise ApiError(
                                        502, "FEATURE_SELECTION_LOOP", "기능 선택을 확인해 주세요."
                                    )
                                yield await asyncio.to_thread(
                                    store.bind_feature, factory, user_id, run_id, item.feature_id
                                )
                                selected = True
                                break
                            if isinstance(item, Decision):
                                if item.action != "reply":
                                    labels = {
                                        "parking_save": "주차 위치를 저장하고 있어요.",
                                        "parking_lookup": "저장한 주차 위치를 확인하고 있어요.",
                                        "note_save": "메모를 저장하고 있어요.",
                                        "event_save": "일정을 저장하고 있어요.",
                                        "reminder_save": "알림 목표 시각을 저장하고 있어요.",
                                        "feature_save": "내 기능에 저장하고 있어요.",
                                    }
                                    yield await asyncio.to_thread(
                                        store.progress,
                                        factory,
                                        run_id,
                                        "action.started",
                                        action=item.action,
                                        message=labels[item.action],
                                    )
                                for event in await asyncio.to_thread(
                                    store.finish, factory, run_id, user_id, item
                                ):
                                    yield event
                            else:
                                kind = item.pop("type")
                                yield await asyncio.to_thread(
                                    store.progress, factory, run_id, kind, **item
                                )
                    if not selected:
                        break
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        code = (
            exc.code
            if isinstance(exc, ApiError)
            else (
                "HERMES_TIMEOUT"
                if isinstance(exc, (TimeoutError, httpx.TimeoutException))
                else "CHAT_FAILED"
            )
        )
        event = await asyncio.to_thread(store.fail, factory, run_id, code)
        if event:
            yield event
    finally:
        # Cancellation closes the upstream stream. A DB action already committed stays committed.
        await asyncio.shield(
            asyncio.to_thread(store.fail, factory, run_id, "CLIENT_DISCONNECTED", True)
        )


async def with_heartbeats(iterator):
    pending = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(anext(iterator))
            ready, _ = await asyncio.wait({pending}, timeout=10)
            if not ready:
                yield ": keepalive\n\n"
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                break
            pending = None
            yield frame(event)
    finally:
        if pending and not pending.done():
            pending.cancel()
        if pending:
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                await pending
        await iterator.aclose()


@router.post(
    "/{conversation_id}/messages",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def send_message(
    conversation_id: UUID,
    payload: ChatMessage,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
    transport: Annotated[httpx.AsyncBaseTransport | None, Depends(get_chat_transport)],
):
    settings = request.app.state.settings
    user_id = user.id
    # Check ownership before agent routing and before reserving a run.
    store.owned(session, conversation_id, user_id)
    runtime = resolve_runtime(settings, user_id, user.tier)
    session.rollback()
    factory = request.app.state.session_factory
    run_id, replay, history = await asyncio.to_thread(
        store.claim,
        factory,
        user_id,
        conversation_id,
        idempotency_key,
        payload.message,
        settings.hermes_timeout_seconds,
        payload.feature_id,
    )
    if replay is not None:

        async def replay_events():
            for event in replay:
                yield frame(event)

        stream = replay_events()
    else:
        stream = with_heartbeats(
            work(factory, run_id, user_id, settings, runtime, transport, payload.message, history)
        )
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Mori-Run-ID": str(run_id),
        },
    )


@router.patch("/{conversation_id}", response_model=ConversationRead)
def edit_conversation(
    conversation_id: UUID, payload: ConversationUpdate, user: CurrentUser, session: DatabaseSession
):
    row = store.owned(session, conversation_id, user.id, lock=True)
    check_revision(row, payload.revision)
    for key, value in payload.model_dump(exclude={"revision"}, exclude_none=True).items():
        setattr(row, key, value)
    row.revision += 1
    row.updated_at = datetime.now(UTC)
    session.commit()
    return row


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID, user: CurrentUser, session: DatabaseSession, revision: int = Query(ge=1)
):
    row = store.owned(session, conversation_id, user.id, lock=True)
    check_revision(row, revision)
    running = list(
        session.scalars(
            select(ChatTurn)
            .where(ChatTurn.conversation_id == row.id, ChatTurn.status == "running")
            .with_for_update()
        )
    )
    for turn in running:
        store.expire(turn)
    if any(turn.status == "running" for turn in running):
        raise ApiError(409, "CHAT_RUNNING", "작업이 끝난 뒤 대화를 삭제해 주세요.")
    row.deleted_at = datetime.now(UTC)
    row.revision += 1
    session.commit()


@router.get("/{conversation_id}", response_model=ConversationRead)
def get_conversation(conversation_id: UUID, user: CurrentUser, session: DatabaseSession):
    return store.owned(session, conversation_id, user.id)
