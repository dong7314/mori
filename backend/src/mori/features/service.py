from datetime import UTC, datetime

from sqlalchemy import select

from mori.errors import ApiError
from mori.features.models import Feature, SkillVersion
from mori.features.schemas import FeatureRead
from mori.organizer.service import check_revision, lock_user, owned

CATALOG = [
    {"key": "parking", "title": "주차 기록", "icon": "car", "template_key": "parking"},
    {"key": "news", "title": "뉴스 브리핑", "icon": "news", "template_key": "text"},
    {"key": "stock", "title": "관심 주가", "icon": "chart", "template_key": "quote"},
    {"key": "note", "title": "메모", "icon": "note", "template_key": "note"},
    {"key": "schedule", "title": "스케줄", "icon": "calendar", "template_key": "event"},
    {"key": "reminder", "title": "알림", "icon": "bell", "template_key": "countdown"},
    {"key": "document", "title": "문서", "icon": "note", "template_key": "document"},
]


def read_feature(row):
    result = FeatureRead.model_validate(row)
    result.automation_status = "not_configured" if row.schedule else "not_requested"
    result.execution_available = (
        row.builtin_key != "stock" and bool(row.work) and row.status == "active"
    )
    return result


def snapshot(row):
    return read_feature(row).model_dump(mode="json")


def save_version(session, row):
    session.add(SkillVersion(feature_id=row.id, version=row.version, definition=snapshot(row)))


def create_feature(session, user_id, payload):
    lock_user(session, user_id)
    if payload.builtin_key and session.scalar(
        select(Feature.id).where(
            Feature.user_id == user_id,
            Feature.builtin_key == payload.builtin_key,
        )
    ):
        raise ApiError(409, "FEATURE_EXISTS", "이미 등록한 기본 기능입니다.")
    row = Feature(
        user_id=user_id,
        **payload.model_dump(mode="json"),
        status="draft" if not payload.work else "active",
    )
    session.add(row)
    session.flush()
    save_version(session, row)
    return row


def update_feature(session, user_id, feature_id, payload):
    row = owned(session, Feature, user_id, feature_id, lock=True)
    check_revision(row, payload.revision)
    for key, value in payload.model_dump(mode="json", exclude={"revision"}).items():
        setattr(row, key, value)
    row.status = "draft" if not row.work else ("active" if row.status == "draft" else row.status)
    row.version += 1
    row.revision += 1
    row.updated_at = datetime.now(UTC)
    session.flush()
    save_version(session, row)
    return row


def executable(session, user_id, feature_id):
    row = owned(session, Feature, user_id, feature_id, lock=True)
    if row.status != "active" or not row.work:
        raise ApiError(409, "FEATURE_NOT_ACTIVE", "실행할 내용과 활성 상태를 확인해 주세요.")
    if row.builtin_key == "stock":
        raise ApiError(503, "MARKET_DATA_NOT_CONFIGURED", "시세 제공자가 연결되지 않았습니다.")
    return row
