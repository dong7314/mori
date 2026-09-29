import asyncio
import contextlib
import json
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.chat import store
from mori.chat.hermes import interpret
from mori.chat.models import ChatTurn, Conversation
from mori.chat.runtime import resolve_runtime
from mori.chat.schemas import ChatMessage, ConversationCreate, ConversationRead, Decision
from mori.database import DatabaseSession
from mori.errors import ApiError

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
    user: CurrentUser, session: DatabaseSession, limit: int = Query(default=50, ge=1, le=100)
):
    return list(
        session.scalars(
            select(Conversation)
            .where(Conversation.user_id == user.id)
            .order_by(Conversation.created_at.desc(), Conversation.id.desc())
            .limit(limit)
        )
    )


@router.get("/{conversation_id}/messages")
def list_messages(
    conversation_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(default=50, ge=1, le=100),
):
    store.owned(session, conversation_id, user.id)
    turns = list(
        session.scalars(
            select(ChatTurn)
            .where(ChatTurn.conversation_id == conversation_id)
            .order_by(ChatTurn.created_at.desc(), ChatTurn.id.desc())
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
                async for item in interpret(client, runtime, settings, message, history):
                    if isinstance(item, Decision):
                        if item.action != "reply":
                            yield await asyncio.to_thread(
                                store.progress,
                                factory,
                                run_id,
                                "action.started",
                                action=item.action,
                                message="주차 위치를 저장하고 있어요."
                                if item.action == "parking_save"
                                else "저장한 주차 위치를 확인하고 있어요.",
                            )
                        for event in await asyncio.to_thread(
                            store.finish, factory, run_id, user_id, item
                        ):
                            yield event
                    else:
                        kind = item.pop("type")
                        yield await asyncio.to_thread(store.progress, factory, run_id, kind, **item)
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
