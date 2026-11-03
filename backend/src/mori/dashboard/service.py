"""Read-only projection of saved records; never starts agents or changes schedules."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Integer, String, cast, func, literal, select, union_all
from sqlalchemy.dialects.postgresql import JSONPATH

from mori.artifacts.models import StoredFile
from mori.features.models import Feature, FeatureResult
from mori.features.service import automation_available
from mori.integrations.models import MarketWatch
from mori.notifications.models import PushSubscription
from mori.organizer.models import CalendarEvent, Document, Note, Reminder
from mori.organizer.service import assistant_preferences
from mori.parking.models import ParkingRecord


def wall_time(day, clock, zone):
    hour, minute = map(int, clock.split(":"))
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone)
    utc = local.astimezone(UTC)
    # Skip a nonexistent DST wall time; an ambiguous time uses the first occurrence.
    return utc if utc.astimezone(zone).replace(tzinfo=None) == local.replace(tzinfo=None) else None


def library(session, user_id, kind, limit, offset, q=""):
    queries = []
    term = q.strip()
    for name, model, field in (
        ("note", Note, Note.body),
        ("document", Document, Document.text),
        ("feature_result", FeatureResult, FeatureResult.text),
    ):
        if kind is not None and kind != name:
            continue
        query = select(
            model.id,
            literal(name).label("kind"),
            model.title,
            func.left(field, 160).label("description"),
            model.updated_at,
            literal(
                {"note": "notes", "document": "documents", "feature_result": "feature-results"}[
                    name
                ]
            ).label("detail_path"),
            (
                func.coalesce(Feature.icon, "spark")
                if model is FeatureResult
                else literal("note" if model is Note else "file")
            ).label("icon"),
            (Document.filename if model is Document else cast(literal(None), String)).label(
                "filename"
            ),
            (
                func.octet_length(Document.text)
                if model is Document
                else cast(literal(None), Integer)
            ).label("size_bytes"),
            (
                func.jsonb_array_length(FeatureResult.items)
                if model is FeatureResult
                else cast(literal(None), Integer)
            ).label("item_count"),
            (
                func.jsonb_array_length(
                    func.jsonb_path_query_array(
                        FeatureResult.items, cast("$[*] ? (@.done == true)", JSONPATH)
                    )
                )
                if model is FeatureResult
                else cast(literal(None), Integer)
            ).label("completed_count"),
        ).where(model.user_id == user_id, model.deleted_at.is_(None))
        if model is FeatureResult:
            query = query.outerjoin(
                Feature,
                (Feature.id == FeatureResult.feature_id)
                & (Feature.user_id == FeatureResult.user_id),
            )
        if term:
            matches = model.title.icontains(term, autoescape=True) | field.icontains(
                term, autoescape=True
            )
            if model is Document:
                matches |= Document.filename.icontains(term, autoescape=True)
            query = query.where(matches)
        queries.append(query)
    if kind in (None, "document"):
        files = select(
            StoredFile.id,
            literal("document").label("kind"),
            StoredFile.filename.label("title"),
            StoredFile.filename.label("description"),
            StoredFile.created_at.label("updated_at"),
            literal("files").label("detail_path"),
            literal("file").label("icon"),
            StoredFile.filename,
            StoredFile.size_bytes,
            cast(literal(None), Integer).label("item_count"),
            cast(literal(None), Integer).label("completed_count"),
        )
        files = files.where(StoredFile.user_id == user_id, StoredFile.deleted_at.is_(None))
        if term:
            files = files.where(StoredFile.filename.icontains(term, autoescape=True))
        queries.append(files)
    rows = union_all(*queries).subquery()
    total = session.scalar(select(func.count()).select_from(rows))
    selected = session.execute(
        select(rows)
        .order_by(rows.c.updated_at.desc(), rows.c.kind, rows.c.id.desc())
        .offset(offset)
        .limit(limit + 1)
    )
    items = []
    for row in selected.mappings():
        value = dict(row)
        value["description"] = value["description"][:160]
        path = value.pop("detail_path")
        value["detail_url"] = f"/v1/{path}/{row['id']}"
        items.append(value)
    return {
        "items": items[:limit],
        "has_more": len(items) > limit,
        "next_offset": offset + limit if len(items) > limit else None,
        "total": total,
    }


def timeline(session, user_id, hours, now, limit, *, settings=None, tier=None):
    prefs = assistant_preferences(session, user_id)
    zone = ZoneInfo(prefs.timezone)
    until = now + timedelta(hours=hours)
    entries = []
    capped = False
    push_ready = (
        bool(settings and settings.push_enabled)
        and session.scalar(
            select(PushSubscription.id)
            .where(
                PushSubscription.user_id == user_id,
                PushSubscription.active.is_(True),
            )
            .limit(1)
        )
        is not None
    )

    def add(
        kind,
        resource_id,
        title,
        description,
        at,
        show_from,
        show_until,
        action,
        url,
        availability="available",
        ongoing=None,
        builtin_key=None,
    ):
        current = show_from <= now and (show_until is None or now < show_until)
        if not current and (hours == 0 or not now <= at < until):
            return
        entries.append(
            dict(
                key=f"{kind}:{resource_id}@{at.isoformat()}",
                kind=kind,
                resource_id=str(resource_id),
                builtin_key=builtin_key,
                title=title,
                description=description,
                at=at,
                show_from=show_from,
                show_until=show_until,
                current=current,
                ongoing=ongoing,
                action=action,
                availability=availability,
                detail_url=url,
            )
        )

    def bounded(query):
        nonlocal capped
        rows = list(session.scalars(query.limit(1001)))
        capped |= len(rows) > 1000
        return rows[:1000]

    events = bounded(
        select(CalendarEvent)
        .where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.ends_at > now,
            CalendarEvent.starts_at <= until + timedelta(minutes=150),
        )
        .order_by(CalendarEvent.starts_at, CalendarEvent.id)
    )
    for row in events:
        add(
            "event",
            row.id,
            row.title,
            row.place,
            row.starts_at,
            row.starts_at - timedelta(minutes=150),
            row.ends_at,
            "appointment",
            f"/v1/calendar/events/{row.id}",
            ongoing=row.starts_at <= now < row.ends_at,
        )
    reminders = bounded(
        select(Reminder)
        .where(
            Reminder.user_id == user_id,
            Reminder.deleted_at.is_(None),
            Reminder.cancelled.is_(False),
            Reminder.target_at >= now,
            Reminder.target_at <= until + timedelta(minutes=90),
        )
        .order_by(Reminder.target_at, Reminder.id)
    )
    for row in reminders:
        add(
            "reminder",
            row.id,
            row.title,
            "알림 목표 시각",
            row.target_at,
            row.target_at - timedelta(minutes=90),
            row.target_at + timedelta(seconds=1),
            "notify",
            f"/v1/reminders/{row.id}",
            "delivery_configured" if push_ready else "delivery_not_configured",
        )
    parking = session.scalar(
        select(ParkingRecord)
        .where(ParkingRecord.user_id == user_id)
        .order_by(ParkingRecord.recorded_at.desc(), ParkingRecord.id.desc())
        .limit(1)
    )
    features = bounded(
        select(Feature)
        .where(
            Feature.user_id == user_id,
            Feature.deleted_at.is_(None),
            Feature.status == "active",
            # JSONB null is distinct from SQL NULL for unscheduled features.
            func.jsonb_typeof(Feature.schedule) == "object",
        )
        .order_by(Feature.id)
    )
    if parking and parking.display_mode == "always":
        add(
            "parking",
            parking.id,
            "출근용 주차 위치" if parking.purpose == "commute" else "외부 주차 위치",
            " ".join(v for v in (parking.floor, parking.zone, parking.spot) if v),
            parking.recorded_at,
            parking.recorded_at,
            None,
            "display",
            "/v1/parking-records/latest",
        )
    schedule = parking.display_schedule if parking else None
    parking_zone = ZoneInfo(schedule["timezone"]) if schedule else zone
    start_day = now.astimezone(parking_zone).date() - timedelta(days=1)
    end_day = until.astimezone(parking_zone).date() + timedelta(days=1)
    day = start_day
    while day <= end_day:
        if parking and parking.display_mode == "scheduled" and schedule:
            at = wall_time(day, schedule["time"], parking_zone)
            if (
                at
                and day.weekday() in schedule["days"]
                and at + timedelta(minutes=schedule["duration_minutes"]) > parking.recorded_at
            ):
                add(
                    "parking",
                    parking.id,
                    "출근용 주차 위치" if parking.purpose == "commute" else "외부 주차 위치",
                    " ".join(v for v in (parking.floor, parking.zone, parking.spot) if v),
                    at,
                    max(at, parking.recorded_at),
                    at + timedelta(minutes=schedule["duration_minutes"]),
                    "display",
                    "/v1/parking-records/latest",
                )
        elif (
            parking
            and parking.display_mode == "scheduled"
            and prefs.parking_enabled
            and prefs.commute_time
            and day.weekday() in prefs.commute_days
        ):
            commute = wall_time(day, prefs.commute_time, zone)
            if commute and commute + timedelta(hours=1) > parking.recorded_at:
                at = commute - timedelta(minutes=prefs.parking_lead_minutes)
                add(
                    "parking",
                    parking.id,
                    "출근길 주차 위치",
                    " ".join(v for v in (parking.floor, parking.zone, parking.spot) if v),
                    at,
                    max(at, parking.recorded_at),
                    commute + timedelta(hours=1),
                    "display",
                    "/v1/parking-records/latest",
                )
        day += timedelta(days=1)
    watch = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
    for row in features:
        schedule = row.schedule
        fzone = ZoneInfo(schedule["timezone"])
        first_day = now.astimezone(fzone).date() - timedelta(days=1)
        # A midnight briefing is visible during the previous day's final half hour.
        last_day = (until + timedelta(minutes=30)).astimezone(fzone).date()
        day = first_day
        while day <= last_day:
            eligible = schedule["repeat"] != "weekdays" or day.weekday() < 5
            if schedule["repeat"] == "once":
                eligible = day.isoformat() == schedule["date"]
            at = wall_time(day, schedule["time"], fzone) if eligible else None
            if at:
                show_from, show_until = at, at + timedelta(minutes=90)
                description, url, action = (
                    row.description or row.work,
                    f"/v1/features/{row.id}",
                    "execute",
                )
                if row.builtin_key == "news":
                    show_from, show_until = at - timedelta(minutes=30), at + timedelta(hours=3)
                    description, url = row.work, "/v1/news"
                elif row.builtin_key == "stock":
                    close = wall_time(day, "16:00", fzone)
                    # Keep explicitly chosen evening schedules usable; 16:00 is the
                    # daytime card default, not a restriction on the user's start time.
                    show_until = close if close is not None and close > at else show_until
                    description = watch.symbol if watch else row.work
                    url, action = "/v1/market/quote", "display"
                add(
                    "feature",
                    row.id,
                    row.title,
                    description,
                    at,
                    show_from,
                    show_until,
                    action,
                    url,
                    "automation_configured"
                    if automation_available(row, settings, tier, session=session)
                    else "automation_not_configured",
                    builtin_key=row.builtin_key,
                )
            day += timedelta(days=1)
    entries.sort(key=lambda x: (not x["current"], x["at"], x["key"]))
    more = capped or len(entries) > limit
    groups = {}
    for entry in entries[:limit]:
        local = entry["at"].astimezone(zone)
        block = local.hour // 6
        key = "current" if entry["current"] else f"{local.date()}-{block}"
        if key not in groups:
            date_label = "오늘" if local.date() == now.astimezone(zone).date() else "내일"
            groups[key] = {
                "key": key,
                "label": "지금 확인할 수 있어요"
                if entry["current"]
                else f"{date_label} {['새벽', '아침', '오후', '저녁'][block]}",
                "items": [],
            }
        groups[key]["items"].append(entry)
    return {
        "server_time": datetime.now(UTC),
        "from": now,
        "until": until,
        "timezone": prefs.timezone,
        "hours": hours,
        "groups": list(groups.values()),
        "count": min(len(entries), limit),
        "truncated": more,
        "next_refresh_at": datetime.now(UTC) + timedelta(seconds=60),
        "recent_records": library(session, user_id, None, 5, 0)["items"],
    }
