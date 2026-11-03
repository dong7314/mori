from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid5

from sqlalchemy import select

from mori.chat.models import ChatJob, ChatTurn, Conversation
from mori.errors import ApiError
from mori.features.models import Feature
from mori.features.service import create_feature, create_feature_result, executable
from mori.features.service import snapshot as feature_snapshot
from mori.organizer.models import CalendarEvent, Note, Reminder
from mori.organizer.schemas import EventRead, NoteRead, ReminderRead
from mori.organizer.service import create_record, lock_user
from mori.organizer.service import owned as owned_record
from mori.parking.schemas import ParkingRead
from mori.parking.service import latest_parking, save_parking


def owned(session, conversation_id, user_id, lock=False):
    query = select(Conversation).where(
        Conversation.id == conversation_id,
        Conversation.user_id == user_id,
        Conversation.deleted_at.is_(None),
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
    if not turn.durable and turn.status == "running" and turn.deadline < datetime.now(UTC):
        turn.status = "interrupted"
        append(turn, "run.interrupted", code="RUN_EXPIRED", message="작업 연결이 종료되었습니다.")


def claim(
    factory,
    user_id,
    conversation_id,
    key,
    message,
    timeout,
    feature_id=None,
    *,
    durable=False,
    attachments=None,
):
    attachments = attachments or []
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
            if (
                prior.message != message
                or prior.requested_feature_id != feature_id
                or prior.attachments != attachments
            ):
                raise ApiError(409, "IDEMPOTENCY_CONFLICT", "다른 내용에 사용된 요청 키입니다.")
            if prior.status == "running" and not prior.durable:
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
        if durable and feature_id:
            # The queued job's User foreign key must not acquire its lock after
            # Feature while another completion holds User and needs Feature.
            lock_user(session, user_id)
        selected = executable(session, user_id, feature_id) if feature_id else None
        from mori.chat.attachments import validate_attachments

        validate_attachments(session, user_id, attachments)
        turn = ChatTurn(
            attachments=attachments,
            requested_feature_id=feature_id,
            feature_id=feature_id,
            feature_snapshot=feature_snapshot(selected) if selected else None,
            conversation_id=conversation_id,
            request_key=key,
            message=message,
            status="running",
            durable=durable,
            events=[],
            deadline=datetime.now(UTC) + timedelta(seconds=timeout + 30),
        )
        conversation = owned(session, conversation_id, user_id)
        conversation.updated_at = datetime.now(UTC)
        session.add(turn)
        session.flush()
        append(turn, "run.accepted", message="요청을 받았어요.")
        if durable:
            session.add(
                ChatJob(
                    run_id=turn.id,
                    user_id=user_id,
                    history=history,
                    status="queued",
                    attempts=0,
                    available_at=datetime.now(UTC),
                )
            )
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
            "attachments": turn.attachments,
            "answer": turn.answer,
            "events": turn.events,
            "durable": turn.durable,
            "job_status": (
                session.get(ChatJob, turn.id).status
                if turn.durable and session.get(ChatJob, turn.id)
                else None
            ),
        }


def progress(factory, run_id, kind, *, lease_token=None, **data):
    with factory.begin() as session:
        turn, _ = checked_turn(session, run_id, lease_token)
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


def perform_action(session, run_id, user_id, decision, action_key, settings=None, prepared=None):
    result = None
    if decision.action == "parking_save":
        record, _ = save_parking(session, user_id, decision.parking, action_key, commit=False)
        result = ParkingRead.model_validate(record).model_dump(mode="json")
        location = " ".join(v for v in (record.floor, record.zone, record.spot) if v)
        answer = f"주차 위치를 {location}(으)로 저장했어요."
        if record.display_mode == "always":
            answer += " 새 위치를 저장하기 전까지 대시보드에 계속 표시해요."
        elif record.display_mode == "manual":
            answer += " 기능 탭의 주차 기록에서 언제든 확인할 수 있어요."
        else:
            schedule = record.display_schedule
            answer += (
                f" {schedule['timezone']} 기준 {schedule['time']}부터 정한 요일에 카드로 표시해요."
            )
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
    elif decision.action in ("note_save", "event_save", "reminder_save"):
        mapping = {
            "note_save": (Note, decision.note, NoteRead, "메모를"),
            "event_save": (CalendarEvent, decision.event, EventRead, "일정을"),
            "reminder_save": (Reminder, decision.reminder, ReminderRead, "알림 목표를"),
        }
        model, payload, read, label = mapping[decision.action]
        record = create_record(session, model, user_id, payload)
        result = read.model_validate(record).model_dump(mode="json")
        answer = f"{label} 저장했어요."
        if decision.action == "reminder_save":
            answer += (
                " 앱에서 남은 시간을 확인할 수 있어요."
                " 알림 상세에서 기기 알림 연결과 전달 상태를 확인해 주세요."
            )
    elif decision.action == "feature_lookup":
        record = owned_record(session, Feature, user_id, decision.feature_id, lock=True)
        if record.builtin_key is not None:
            raise ApiError(404, "FEATURE_NOT_FOUND", "내 기능을 찾을 수 없습니다.")
        result = {
            "id": str(record.id),
            "title": record.title,
            "status": record.status,
            "version": record.version,
        }
        state = {"active": "사용 중", "paused": "잠시 중지된 상태", "draft": "초안 상태"}
        answer = (
            f"‘{record.title}’ 기능은 {state[record.status]}예요. "
            "상세 화면에서 내용을 확인할 수 있어요."
        )
    elif decision.action == "feature_save":
        if decision.feature.allowed_actions != ["reply"]:
            raise ApiError(
                409,
                "FEATURE_POLICY_REQUIRES_CONFIRMATION",
                "기능의 저장 작업 권한은 기능 설정에서 직접 선택해 주세요.",
            )
        # Chat repeats reopen the existing exact title, as in the feature-create
        # conversation flow. Direct form creation can still use duplicate names.
        lock_user(session, user_id)
        existing = (
            session.scalar(
                select(Feature)
                .where(
                    Feature.user_id == user_id,
                    Feature.deleted_at.is_(None),
                    Feature.builtin_key.is_(None),
                    Feature.title == decision.feature.title,
                )
                .order_by(Feature.created_at, Feature.id)
                .limit(1)
            )
            if decision.feature.builtin_key is None
            else None
        )
        record = existing or create_feature(session, user_id, decision.feature)
        result = feature_snapshot(record)
        if existing:
            return (
                f"이미 ‘{record.title}’ 기능이 있어요. "
                "상세 화면에서 내용을 확인하거나 편집할 수 있어요.",
                result,
            )
        answer = "내 기능에 저장했어요."
        if record.status == "draft":
            answer += " 수행할 내용을 입력하면 실행할 수 있어요."
        if record.schedule:
            answer += " 시간 설정도 저장했어요. 기능 상세에서 자동 실행 가능 상태를 확인해 주세요."
    elif decision.action == "document_process":
        from mori.artifacts.schemas import DocumentJobRead
        from mori.artifacts.service import create_job

        if settings is None:
            raise ApiError(503, "DOCUMENTS_NOT_CONFIGURED", "문서 처리가 설정되지 않았습니다.")
        record = create_job(session, user_id, decision.document, action_key, settings)
        result = DocumentJobRead.model_validate(record).model_dump(mode="json")
        answer = "문서 작업을 등록했어요. 작업 상태에서 완료 여부와 결과 파일을 확인할 수 있어요."
    elif decision.action in {"news_settings", "news_refresh", "market_settings", "market_lookup"}:
        from mori.chat.integrations import perform

        return perform(session, user_id, decision, settings, prepared)
    else:
        answer = decision.reply
    return answer, result


def checked_turn(session, run_id, lease_token=None):
    job = None
    if lease_token is not None:
        job = session.get(ChatJob, run_id, with_for_update=True)
        if (
            job is None
            or job.status != "processing"
            or job.lease_token != lease_token
            or job.lease_until is None
            or job.lease_until <= datetime.now(UTC)
        ):
            raise ApiError(409, "CHAT_LEASE_LOST", "작업의 실행 권한이 만료되었습니다.")
    turn = session.get(ChatTurn, run_id, with_for_update=True)
    if turn is None or turn.status != "running" or turn.deadline < datetime.now(UTC):
        raise ApiError(409, "RUN_ENDED", "이미 종료된 작업입니다.")
    if turn.durable and job is None:
        raise ApiError(409, "CHAT_LEASE_REQUIRED", "작업 실행 권한을 확인해 주세요.")
    return turn, job


def execute_actions(
    session, turn, user_id, decision, settings=None, prepared=None, *, feature_context_ids=None
):
    """Execute bounded domain writes and append evidence in the caller's transaction."""
    actions = decision.actions if decision.action == "batch" else [decision]
    answers, events = [], []
    paths = {
        "parking_save": "parking-records/latest",
        "parking_lookup": "parking-records/latest",
        "note_save": "notes",
        "event_save": "calendar/events",
        "reminder_save": "reminders",
        "feature_save": "features",
        "feature_lookup": "features",
        "document_process": "document-jobs",
        "news_settings": "news",
        "news_refresh": "news",
        "market_settings": "market/settings",
        "market_lookup": "market/snapshot",
    }
    for index, action in enumerate(actions):
        if action.action == "feature_lookup" and str(action.feature_id) not in (
            feature_context_ids or ()
        ):
            raise ApiError(404, "FEATURE_NOT_FOUND", "현재 문맥에서 내 기능을 찾을 수 없습니다.")
        action_key = turn.id if len(actions) == 1 else uuid5(turn.id, str(index))
        answer, result = perform_action(
            session, turn.id, user_id, action, action_key, settings, prepared
        )
        answers.append(answer)
        if action.action != "reply":
            ref = None
            if result is not None:
                path = paths[action.action]
                url = (
                    f"/v1/{path}"
                    if action.action.startswith(("parking_", "news_", "market_"))
                    else f"/v1/{path}/{result['id']}"
                )
                ref = {
                    "resource_id": result["id"],
                    "kind": "document_job"
                    if action.action == "document_process"
                    else "news"
                    if action.action.startswith("news_")
                    else "stock"
                    if action.action.startswith("market_")
                    else "parking"
                    if action.action.startswith("parking_")
                    else "feature"
                    if action.action == "feature_lookup"
                    else action.action.removesuffix("_save"),
                    "detail_url": url,
                }
            events.append(
                append(
                    turn,
                    "action.queued" if action.action == "document_process" else "action.completed",
                    action=action.action,
                    result=result,
                    result_ref=ref,
                )
            )
    return "\n".join(answers), events


def finish(
    factory,
    run_id,
    user_id: UUID,
    decision,
    *,
    lease_token=None,
    settings=None,
    runtime_url=None,
    prepared=None,
    feature_context_ids=None,
):
    # Lease fencing, every domain write, success evidence and job completion are atomic.
    with factory.begin() as session:
        turn, job = checked_turn(session, run_id, lease_token)
        if job and job.user_id != user_id:
            raise ApiError(404, "RUN_NOT_FOUND", "작업을 찾을 수 없습니다.")
        from mori.chat.attachments import validate_attachments

        if settings is not None:
            from mori.auth.models import User
            from mori.chat.runtime import resolve_runtime

            user = session.get(User, user_id, with_for_update=True)
            if user is None:
                raise ApiError(404, "USER_NOT_FOUND", "사용자를 찾을 수 없습니다.")
            runtime = resolve_runtime(settings, user_id, user.tier, session=session)
            if runtime_url is not None and runtime.url != runtime_url:
                raise ApiError(409, "CHAT_RUNTIME_CHANGED", "에이전트 배정이 변경되었습니다.")
        validate_attachments(session, user_id, turn.attachments, lock=True)
        if turn.feature_id:
            from mori.features.policy import permitted_actions

            selected = executable(session, user_id, turn.feature_id)
            if selected.version != turn.feature_snapshot["version"]:
                raise ApiError(409, "FEATURE_CHANGED", "실행 중 기능이 변경되었습니다.")
            actions = permitted_actions(turn.feature_snapshot, decision)
            if settings is None and any(action.action != "reply" for action in actions):
                raise ApiError(
                    503, "FEATURE_EXECUTION_NOT_CONFIGURED", "기능 실행 환경이 필요합니다."
                )
        answer, events = execute_actions(
            session,
            turn,
            user_id,
            decision,
            settings,
            prepared,
            feature_context_ids=feature_context_ids,
        )
        if decision.reminder_requested:
            answer += "\n추가 알림은 함께 예약하지 않았어요. 알림 요청을 따로 보내 주세요."
            events.append(
                append(
                    turn,
                    "capability.unavailable",
                    capability="combined_actions",
                    message="추가 알림은 별도 요청으로 예약해 주세요.",
                )
            )
        if turn.feature_id:
            saved = create_feature_result(
                session,
                user_id=user_id,
                feature_id=turn.feature_id,
                feature_version=turn.feature_snapshot["version"],
                run_id=turn.id,
                title=turn.feature_snapshot["title"],
                text=answer,
            )
            events.append(
                append(
                    turn,
                    "result.saved",
                    result_id=str(saved.id),
                    feature_id=str(turn.feature_id),
                    detail_url=f"/v1/feature-results/{saved.id}",
                    result_ref={
                        "resource_id": str(saved.id),
                        "kind": "feature_result",
                        "detail_url": f"/v1/feature-results/{saved.id}",
                    },
                )
            )
        turn.answer = answer
        turn.status = "completed"
        events.append(append(turn, "message.completed", text=answer))
        events.append(append(turn, "run.completed"))
        if job:
            job.status = "completed"
            job.lease_token = None
            job.lease_until = None
            job.error_code = None
            job.updated_at = datetime.now(UTC)
        return events


def bind_feature(factory, user_id, run_id, feature_id, *, lease_token=None):
    with factory.begin() as session:
        turn, _ = checked_turn(session, run_id, lease_token)
        owned(session, turn.conversation_id, user_id)
        if turn.status != "running" or turn.feature_id or turn.deadline < datetime.now(UTC):
            raise ApiError(409, "FEATURE_ALREADY_BOUND", "기능을 다시 선택할 수 없습니다.")
        row = executable(session, user_id, feature_id)
        turn.feature_id = row.id
        turn.feature_snapshot = feature_snapshot(row)
        return append(
            turn,
            "feature.selected",
            feature_id=str(row.id),
            version=row.version,
            message="등록한 기능으로 작업을 이어갈게요.",
        )
