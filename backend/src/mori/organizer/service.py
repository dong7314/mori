import hashlib
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import defer

from mori.auth.models import User
from mori.errors import ApiError
from mori.organizer.models import CalendarEvent, Note, Reminder, UserPreference, WriteReceipt
from mori.organizer.schemas import AssistantPreferences


def lock_user(session, user_id):
    session.execute(select(User.id).where(User.id == user_id).with_for_update())


def owned(
    session, model, user_id, resource_id, *, include_deleted=False, lock=False, defer_fields=()
):
    query = select(model).where(model.id == resource_id, model.user_id == user_id)
    if not include_deleted:
        query = query.where(model.deleted_at.is_(None))
    if lock:
        query = query.with_for_update()
    if defer_fields:
        query = query.options(*(defer(getattr(model, name)) for name in defer_fields))
    row = session.scalar(query)
    if row is None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "항목을 찾을 수 없습니다.")
    return row


def check_revision(row, revision):
    if row.revision != revision:
        raise ApiError(409, "REVISION_CONFLICT", "다른 곳에서 변경됐어요. 다시 조회해 주세요.")


def check_datetime(value):
    try:
        value.astimezone(UTC)
    except OverflowError as exc:
        raise ApiError(422, "INVALID_DATETIME", "UTC로 표현할 수 없는 시각입니다.") from exc


def record_datetime_fields(model):
    if model is CalendarEvent:
        return ("starts_at", "ends_at")
    return ("target_at",) if model is Reminder else ()


def update_record(session, model, user_id, resource_id, payload):
    fields = record_datetime_fields(model)
    for name in fields:
        check_datetime(getattr(payload, name))
    # All these timestamps are replaced by the payload. Deferring their old
    # values lets a normal PUT repair legacy dates outside Python's UTC range.
    row = owned(session, model, user_id, resource_id, lock=True, defer_fields=fields)
    check_revision(row, payload.revision)
    if model is Reminder and payload.target_at <= datetime.now(UTC):
        raise ApiError(422, "REMINDER_IN_PAST", "알림 목표 시각은 현재 이후여야 합니다.")
    for key, value in payload.model_dump(exclude={"revision"}).items():
        setattr(row, key, value)
    row.revision += 1
    row.updated_at = datetime.now(UTC)
    session.flush()
    return row


def set_deleted(session, model, user_id, resource_id, revision, *, restore=False):
    row = owned(session, model, user_id, resource_id, include_deleted=True, lock=True)
    check_revision(row, revision)
    if (row.deleted_at is None) != restore:
        row.deleted_at = None if restore else datetime.now(UTC)
        row.revision += 1
        # A note's displayed date and today's-note context follow its last
        # content save. Undo restores that position without making it new work.
        if model is not Note:
            row.updated_at = datetime.now(UTC)
    session.commit()
    return row


def create_record(session, model, user_id, payload):
    for name in record_datetime_fields(model):
        check_datetime(getattr(payload, name))
    if model is Reminder and payload.target_at <= datetime.now(UTC):
        raise ApiError(422, "REMINDER_IN_PAST", "알림 목표 시각은 현재 이후여야 합니다.")
    row = model(user_id=user_id, **payload.model_dump())
    session.add(row)
    session.flush()
    return row


def idempotent_create(session, user_id, scope, key, payload, make, serialize):
    # A user row lock covers the receipt and side effect in the same transaction,
    # including cross-process concurrent retries. Never commit a receipt alone.
    lock_user(session, user_id)
    digest = hashlib.sha256(payload.model_dump_json().encode()).hexdigest()
    prior = session.scalar(
        select(WriteReceipt).where(
            WriteReceipt.user_id == user_id,
            WriteReceipt.scope == scope,
            WriteReceipt.key == key,
        )
    )
    if prior:
        if prior.request_hash != digest:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "다른 내용에 사용된 요청 키입니다.")
        session.commit()
        return prior.response
    result = serialize(make()).model_dump(mode="json")
    session.add(
        WriteReceipt(user_id=user_id, scope=scope, key=key, request_hash=digest, response=result)
    )
    session.commit()
    return result


def assistant_preferences(session, user_id):
    row = session.get(UserPreference, user_id)
    return AssistantPreferences.model_validate(row.data if row else {})
