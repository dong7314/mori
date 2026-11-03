import asyncio
import contextlib
import json
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, true

from mori.auth.dependencies import CurrentUser
from mori.chat import store
from mori.chat.context import execution_context
from mori.chat.hermes import interpret
from mori.chat.models import ChatTurn, Conversation
from mori.chat.runtime import resolve_runtime
from mori.chat.schemas import (
    ChatMessage,
    ConversationCreate,
    ConversationListRead,
    ConversationRead,
    ConversationUpdate,
    Decision,
    RunAccepted,
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


@router.get("", response_model=list[ConversationListRead])
def list_conversations(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
    q: str = Query("", max_length=200, pattern=r"^[^\x00]*$"),
):
    latest = (
        select(
            func.coalesce(ChatTurn.answer, ChatTurn.message).label("message"),
            ChatTurn.created_at.label("at"),
        )
        .where(ChatTurn.conversation_id == Conversation.id)
        .order_by(ChatTurn.created_at.desc(), ChatTurn.id.desc())
        .limit(1)
        .lateral()
    )
    activity = func.coalesce(latest.c.at, Conversation.created_at)
    return [
        {
            **ConversationRead.model_validate(row).model_dump(),
            "last_message": last_message,
            "last_activity_at": last_activity_at,
        }
        for row, last_message, last_activity_at in session.execute(
            select(Conversation, latest.c.message, activity)
            .outerjoin(latest, true())
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
            .order_by(Conversation.pinned.desc(), activity.desc(), Conversation.id.desc())
            .offset(offset)
            .limit(limit)
        )
    ]


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
            "attachments": t.attachments,
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


async def work(
    factory, run_id, user_id, settings, runtime, transport, message, history, *, lease_token=None
):
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
            lease_token=lease_token,
        )
        async with asyncio.timeout(settings.hermes_timeout_seconds):
            from mori.chat.attachments import prepare_attachments

            attachments = await asyncio.to_thread(
                prepare_attachments, factory, settings, user_id, run_id, lease_token
            )
            async with httpx.AsyncClient(
                transport=transport, trust_env=False, follow_redirects=False
            ) as client:
                # At most one selection round followed by the pinned skill execution.
                for attempt in range(2):
                    context = await asyncio.to_thread(
                        execution_context, factory, user_id, run_id, attachments=attachments
                    )
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
                                    store.bind_feature,
                                    factory,
                                    user_id,
                                    run_id,
                                    item.feature_id,
                                    lease_token=lease_token,
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
                                        "feature_lookup": "내 기능의 상태를 확인하고 있어요.",
                                        "batch": "요청한 내용을 함께 저장하고 있어요.",
                                        "document_process": "문서 작업을 등록하고 있어요.",
                                        "news_settings": "뉴스 설정을 저장하고 있어요.",
                                        "news_refresh": "뉴스를 수집하고 있어요.",
                                        "market_settings": "관심 종목을 저장하고 있어요.",
                                        "market_lookup": "관심 종목의 시세를 확인하고 있어요.",
                                    }
                                    yield await asyncio.to_thread(
                                        store.progress,
                                        factory,
                                        run_id,
                                        "action.started",
                                        action=item.action,
                                        message=labels[item.action],
                                        lease_token=lease_token,
                                    )
                                from mori.chat.integrations import prepare

                                prepared = await prepare(
                                    factory,
                                    settings,
                                    run_id,
                                    user_id,
                                    item,
                                    lease_token=lease_token,
                                    transport=transport,
                                )
                                for event in await asyncio.to_thread(
                                    store.finish,
                                    factory,
                                    run_id,
                                    user_id,
                                    item,
                                    lease_token=lease_token,
                                    settings=settings,
                                    runtime_url=runtime.url,
                                    prepared=prepared,
                                    feature_context_ids=[
                                        feature["id"] for feature in json.loads(context)["features"]
                                    ],
                                ):
                                    yield event
                            else:
                                kind = item.pop("type")
                                yield await asyncio.to_thread(
                                    store.progress,
                                    factory,
                                    run_id,
                                    kind,
                                    lease_token=lease_token,
                                    **item,
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
        if lease_token is not None:
            raise ApiError(502, code, "작업을 완료하지 못했습니다.") from exc
        event = await asyncio.to_thread(store.fail, factory, run_id, code)
        if event:
            yield event
    finally:
        # Legacy callers own this generator; durable jobs are fenced and recovered by their worker.
        if lease_token is None:
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


def enqueue(request, session, user, conversation_id, payload, idempotency_key):
    settings = request.app.state.settings
    store.owned(session, conversation_id, user.id)
    resolve_runtime(settings, user.id, user.tier, session=session)
    if not settings.chat_worker_enabled:
        raise ApiError(503, "CHAT_WORKER_DISABLED", "채팅 작업 실행이 아직 활성화되지 않았습니다.")
    if any(ref.kind == "file" for ref in payload.attachments) and not settings.documents_enabled:
        raise ApiError(503, "DOCUMENTS_NOT_CONFIGURED", "문서 처리가 설정되지 않았습니다.")
    user_id = user.id
    session.rollback()
    return store.claim(
        request.app.state.session_factory,
        user_id,
        conversation_id,
        idempotency_key,
        payload.message,
        settings.hermes_timeout_seconds,
        payload.feature_id,
        durable=True,
        attachments=[ref.model_dump(mode="json") for ref in payload.attachments],
    )[0]


async def observe(factory, user_id, conversation_id, run_id, *, after=0, seconds=25):
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        snapshot = await asyncio.to_thread(
            store.snapshot, factory, user_id, conversation_id, run_id
        )
        for event in snapshot["events"]:
            if event["id"] > after:
                after = event["id"]
                yield frame({**event, "run_id": str(run_id)})
        if snapshot["status"] != "running" or asyncio.get_running_loop().time() >= deadline:
            return
        yield ": keepalive\n\n"
        await asyncio.sleep(0.25)


def stream_response(request, user_id, conversation_id, run_id, after=0):
    return StreamingResponse(
        observe(
            request.app.state.session_factory,
            user_id,
            conversation_id,
            run_id,
            after=after,
            seconds=request.app.state.settings.chat_stream_seconds,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Mori-Run-ID": str(run_id),
        },
    )


@router.post(
    "/{conversation_id}/messages",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
def send_message(
    conversation_id: UUID,
    payload: ChatMessage,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    user_id = user.id
    run_id = enqueue(request, session, user, conversation_id, payload, idempotency_key)
    return stream_response(request, user_id, conversation_id, run_id)


@router.post("/{conversation_id}/runs", status_code=202, response_model=RunAccepted)
def submit_run(
    conversation_id: UUID,
    payload: ChatMessage,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    run_id = enqueue(request, session, user, conversation_id, payload, idempotency_key)
    path = f"/v1/conversations/{conversation_id}/runs/{run_id}"
    return {"run_id": str(run_id), "status_url": path, "events_url": path + "/events"}


@router.get(
    "/{conversation_id}/runs/{run_id}/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
def run_events(
    conversation_id: UUID,
    run_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    after: int = Query(0, ge=0, le=10000),
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
):
    user_id = user.id
    store.owned(session, conversation_id, user_id)
    session.rollback()
    store.snapshot(request.app.state.session_factory, user_id, conversation_id, run_id)
    if last_event_id:
        try:
            previous_run, cursor = last_event_id.rsplit(":", 1)
            if UUID(previous_run) != run_id or not 0 <= int(cursor) <= 10000:
                raise ValueError
            after = max(after, int(cursor))
        except (ValueError, TypeError) as exc:
            raise ApiError(422, "INVALID_EVENT_CURSOR", "이벤트 위치를 확인해 주세요.") from exc
    return stream_response(request, user_id, conversation_id, run_id, after)


@router.post("/{conversation_id}/runs/{run_id}/cancel")
def cancel_run(
    conversation_id: UUID,
    run_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    from mori.chat.jobs import cancel

    user_id = user.id
    session.rollback()
    return cancel(request.app.state.session_factory, user_id, conversation_id, run_id)


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
