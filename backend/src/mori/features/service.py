import re
from datetime import UTC, datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import select

from mori.errors import ApiError
from mori.features.models import Feature, FeatureResult, SkillVersion
from mori.features.schemas import FeatureRead, Schedule
from mori.organizer.service import assistant_preferences, check_revision, lock_user, owned

CATALOG = [
    {"key": "parking", "title": "주차 기록", "icon": "car", "template_key": "parking"},
    {"key": "news", "title": "뉴스 브리핑", "icon": "news", "template_key": "text"},
    {"key": "stock", "title": "관심 주가", "icon": "chart", "template_key": "quote"},
    {"key": "note", "title": "메모", "icon": "note", "template_key": "note"},
    {"key": "schedule", "title": "스케줄", "icon": "calendar", "template_key": "event"},
    {"key": "reminder", "title": "알림", "icon": "bell", "template_key": "countdown"},
    {"key": "document", "title": "문서", "icon": "note", "template_key": "document"},
]


def automation_available(row, settings, tier=None, session=None):
    if not settings or not settings.automation_enabled:
        return False
    if row.builtin_key == "news":
        return bool(settings.searxng_base_url)
    if row.builtin_key == "stock":
        from mori.integrations.market import market_configured

        return market_configured(settings)
    return (
        chat_available(settings, row.user_id, tier, session=session)
        if tier is not None
        else settings.chat_enabled
    )


def chat_available(settings, user_id, tier, session=None):
    from mori.chat.runtime import resolve_runtime

    try:
        resolve_runtime(settings, user_id, tier, session=session)
        return True
    except ApiError:
        return False


def read_feature(row, settings=None, tier=None, session=None):
    result = FeatureRead.model_validate(row)
    result.automation_status = "not_configured" if row.schedule else "not_requested"
    if row.schedule and automation_available(row, settings, tier, session=session):
        result.automation_status = "configured"
    result.execution_available = (
        row.builtin_key != "stock" and bool(row.work) and row.status == "active"
    )
    if settings and tier is not None:
        result.execution_available = (
            result.execution_available
            and settings.chat_worker_enabled
            and chat_available(
                settings,
                row.user_id,
                tier,
                session=session,
            )
        )
    return result


def snapshot(row):
    return read_feature(row).model_dump(mode="json")


def save_version(session, row):
    session.add(SkillVersion(feature_id=row.id, version=row.version, definition=snapshot(row)))


def normalize_schedule(session, user_id, schedule, *, previous=None, now=None):
    if schedule is None:
        return None
    result = schedule.model_dump(mode="json")
    if "timezone" not in schedule.model_fields_set:
        result["timezone"] = (
            previous["timezone"] if previous else assistant_preferences(session, user_id).timezone
        )
    if result["repeat"] == "once" and result["date"] is None:
        if previous and previous["repeat"] == "once" and previous.get("date"):
            # Editing a definition must not silently reschedule a consumed or past occurrence.
            result["date"] = previous["date"]
        else:
            instant = now or datetime.now(UTC)
            zone = ZoneInfo(result["timezone"])
            local_now = instant.astimezone(zone)
            occurrence = datetime.combine(
                local_now.date(), time.fromisoformat(result["time"]), tzinfo=local_now.tzinfo
            )
            while occurrence.astimezone(UTC) <= instant or occurrence.astimezone(UTC).astimezone(
                zone
            ).replace(tzinfo=None) != occurrence.replace(tzinfo=None):
                # Match dashboard/scheduler policy: skip missing DST wall times,
                # and use the first occurrence when a wall time is ambiguous.
                occurrence += timedelta(days=1)
            result["date"] = occurrence.date().isoformat()
    return result


def schedule_for_write(session, user_id, schedule, *, previous=None):
    result = normalize_schedule(session, user_id, schedule, previous=previous)
    if result is not None:
        try:
            # Resolve inherited timezone/date values before checking UTC bounds.
            Schedule.model_validate(result).validate_utc_range()
        except (ValueError, OverflowError) as exc:
            raise ApiError(
                422, "VALIDATION_ERROR", "예약 시각을 UTC와 현지 시각으로 표현할 수 없습니다."
            ) from exc
    return result


def create_feature(session, user_id, payload):
    lock_user(session, user_id)
    if payload.builtin_key and session.scalar(
        select(Feature.id).where(
            Feature.user_id == user_id,
            Feature.builtin_key == payload.builtin_key,
        )
    ):
        raise ApiError(409, "FEATURE_EXISTS", "이미 등록한 기본 기능입니다.")
    definition = payload.model_dump(mode="json")
    definition["schedule"] = schedule_for_write(session, user_id, payload.schedule)
    row = Feature(
        user_id=user_id,
        **definition,
        status="draft" if not payload.work else "active",
    )
    session.add(row)
    session.flush()
    save_version(session, row)
    return row


def update_feature(session, user_id, feature_id, payload):
    row = owned(session, Feature, user_id, feature_id, lock=True)
    check_revision(row, payload.revision)
    previous_work, previous_revision = row.work, row.revision
    definition = payload.model_dump(mode="json", exclude={"revision"})
    definition["schedule"] = schedule_for_write(
        session, user_id, payload.schedule, previous=row.schedule
    )
    for key, value in definition.items():
        setattr(row, key, value)
    row.status = "draft" if not row.work else ("active" if row.status == "draft" else row.status)
    row.version += 1
    row.revision += 1
    row.updated_at = datetime.now(UTC)
    if row.builtin_key == "news" and row.work == previous_work:
        from mori.integrations.news import rebase_briefing

        rebase_briefing(session, row, previous_revision)
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


_LIST_ITEM = re.compile(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)(\S.*?)\s*$")
_CHECKBOX = re.compile(r"^\[([ xX])\](?:\s+(.*))?$")
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")


def result_items(text):
    """Extract explicit Markdown list lines; keep prose and code out of checklist state."""
    items = []
    fence = None
    for line in text.splitlines():
        marker = _FENCE.match(line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif (
                token[0] == fence[0]
                and len(token) >= len(fence)
                and not line[marker.end() :].strip()
            ):
                fence = None
            continue
        if fence is not None:
            continue
        match = _LIST_ITEM.match(line)
        if match:
            value = match.group(1)
            checkbox = _CHECKBOX.match(value)
            if checkbox:
                value = (checkbox.group(2) or "").strip()
            if value and not re.fullmatch(r"[-*_](?:\s*[-*_]){2,}", line.strip()):
                items.append(
                    {
                        "id": str(uuid4()),
                        "text": value,
                        "done": bool(checkbox and checkbox.group(1) in ("x", "X")),
                    }
                )
    return items


def create_feature_result(session, *, user_id, feature_id, feature_version, run_id, title, text):
    row = FeatureResult(
        user_id=user_id,
        feature_id=feature_id,
        feature_version=feature_version,
        run_id=run_id,
        title=title,
        text=text,
        items=result_items(text),
    )
    session.add(row)
    session.flush()
    return row


def update_result_item(session, user_id, result_id, item_id, payload):
    row = owned(session, FeatureResult, user_id, result_id, lock=True)
    check_revision(row, payload.revision)
    target = str(item_id)
    if not any(item["id"] == target for item in row.items):
        raise ApiError(404, "RESULT_ITEM_NOT_FOUND", "결과 항목을 찾을 수 없습니다.")
    if any(item["id"] == target and item["done"] != payload.done for item in row.items):
        row.items = [
            {**item, "done": payload.done} if item["id"] == target else item for item in row.items
        ]
        row.revision += 1
        row.updated_at = datetime.now(UTC)
        session.flush()
    return row
