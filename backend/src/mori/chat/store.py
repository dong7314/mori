from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select

from mori.chat.models import ChatTurn, Conversation
from mori.errors import ApiError
from mori.parking.schemas import ParkingRead
from mori.parking.service import latest_parking, save_parking


def owned(session, conversation_id, user_id, lock=False):
    query = select(Conversation).where(
        Conversation.id == conversation_id, Conversation.user_id == user_id
    )
    if lock:
        query = query.with_for_update()
    row = session.scalar(query)
    if row is None:
        raise ApiError(404, "CONVERSATION_NOT_FOUND", "대화를 찾을 수 없습니다.")
    return row


def append(turn, kind, **data):
    event = {"id": len(turn.events) + 1, "type": kind, "run_id": str(turn.id), **data}
    turn.events = [*turn.events, event]
    return event


def expire(turn):
    if turn.status == "running" and turn.deadline < datetime.now(UTC):
        turn.status = "interrupted"
        append(turn, "run.interrupted", code="RUN_EXPIRED", message="작업 연결이 종료되었습니다.")


def claim(factory, user_id, conversation_id, key, message, timeout):
    with factory.begin() as session:
        owned(session, conversation_id, user_id, lock=True)
        running = list(
            session.scalars(
                select(ChatTurn)
                .where(ChatTurn.conversation_id == conversation_id, ChatTurn.status == "running")
                .with_for_update()
            )
        )
        for turn in running:
            expire(turn)
        prior = session.scalar(
            select(ChatTurn)
            .where(ChatTurn.conversation_id == conversation_id, ChatTurn.request_key == key)
            .with_for_update()
        )
        if prior:
            if prior.message != message:
                raise ApiError(409, "IDEMPOTENCY_CONFLICT", "다른 내용에 사용된 요청 키입니다.")
            if prior.status == "running":
                raise ApiError(
                    409, "CHAT_RUNNING", "이미 실행 중입니다. 실행 기록을 조회해 주세요."
                )
            return prior.id, prior.events, []
        if any(t.status == "running" for t in running):
            raise ApiError(409, "CHAT_RUNNING", "이 대화의 이전 작업이 실행 중입니다.")
        turns = list(
            session.scalars(
                select(ChatTurn)
                .where(ChatTurn.conversation_id == conversation_id, ChatTurn.status == "completed")
                .order_by(ChatTurn.created_at.desc(), ChatTurn.id.desc())
                .limit(10)
            )
        )
        history = []
        size = 0
        for turn in turns:
            if size + len(turn.message) + len(turn.answer or "") > 32000:
                break
            history[:0] = [
                {"role": "user", "content": turn.message},
                {"role": "assistant", "content": turn.answer or ""},
            ]
            size += len(turn.message) + len(turn.answer or "")
        turn = ChatTurn(
            conversation_id=conversation_id,
            request_key=key,
            message=message,
            status="running",
            events=[],
            deadline=datetime.now(UTC) + timedelta(seconds=timeout + 30),
        )
        session.add(turn)
        session.flush()
        append(turn, "run.accepted", message="요청을 받았어요.")
        return turn.id, None, history


def snapshot(factory, user_id, conversation_id, run_id):
    with factory.begin() as session:
        owned(session, conversation_id, user_id)
        turn = session.scalar(
            select(ChatTurn)
            .where(ChatTurn.id == run_id, ChatTurn.conversation_id == conversation_id)
            .with_for_update()
        )
        if turn is None:
            raise ApiError(404, "RUN_NOT_FOUND", "작업을 찾을 수 없습니다.")
        expire(turn)
        return {
            "id": str(turn.id),
            "status": turn.status,
            "message": turn.message,
            "answer": turn.answer,
            "events": turn.events,
        }


def progress(factory, run_id, kind, **data):
    with factory.begin() as session:
        turn = session.get(ChatTurn, run_id, with_for_update=True)
        if turn.status != "running" or turn.deadline < datetime.now(UTC):
            raise ApiError(409, "RUN_ENDED", "이미 종료된 작업입니다.")
        if len(turn.events) >= 120:
            raise ApiError(502, "TOO_MANY_EVENTS", "작업 단계가 너무 많습니다.")
        return append(turn, kind, **data)


def fail(factory, run_id, code, interrupted=False):
    with factory.begin() as session:
        turn = session.get(ChatTurn, run_id, with_for_update=True)
        if turn.status != "running":
            return None
        turn.status = "interrupted" if interrupted else "failed"
        return append(
            turn,
            "run." + turn.status,
            code=code,
            message="작업이 중단되었습니다. 대화 기록에서 결과를 확인해 주세요.",
        )


def finish(factory, run_id, user_id: UUID, decision):
    # Commit the DB side effect and its public success evidence in ONE transaction.
    with factory.begin() as session:
        turn = session.get(ChatTurn, run_id, with_for_update=True)
        if turn.status != "running" or turn.deadline < datetime.now(UTC):
            raise ApiError(409, "RUN_ENDED", "이미 종료된 작업입니다.")
        result = None
        if decision.action == "parking_save":
            record, _ = save_parking(session, user_id, decision.parking, run_id, commit=False)
            result = ParkingRead.model_validate(record).model_dump(mode="json")
            location = " ".join(v for v in (record.floor, record.zone, record.spot) if v)
            answer = f"주차 위치를 {location}(으)로 저장했어요."
        elif decision.action == "parking_lookup":
            try:
                record = latest_parking(session, user_id)
                result = ParkingRead.model_validate(record).model_dump(mode="json")
                location = " ".join(v for v in (record.floor, record.zone, record.spot) if v)
                answer = f"마지막으로 저장한 주차 위치는 {location}입니다."
            except ApiError as exc:
                if exc.code != "PARKING_NOT_FOUND":
                    raise
                answer = "아직 저장한 주차 위치가 없어요."
        else:
            answer = decision.reply
        if decision.reminder_requested:
            answer += "\n예약 알림은 아직 지원하지 않아 예약하지 않았어요."
        events = []
        if decision.action != "reply":
            events.append(append(turn, "action.completed", action=decision.action, result=result))
        if decision.reminder_requested:
            events.append(
                append(
                    turn,
                    "capability.unavailable",
                    capability="reminders",
                    message="예약 알림은 아직 지원하지 않아요.",
                )
            )
        turn.answer = answer
        turn.status = "completed"
        events.append(append(turn, "message.completed", text=answer))
        events.append(append(turn, "run.completed"))
        return events
