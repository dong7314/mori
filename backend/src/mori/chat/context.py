import json
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from mori.chat.models import ChatTurn
from mori.features.models import Feature
from mori.features.service import CATALOG, executable
from mori.organizer.models import Note
from mori.organizer.service import assistant_preferences


def execution_context(factory, user_id, run_id):
    with factory() as session:
        turn = session.get(ChatTurn, run_id)
        prefs = assistant_preferences(session, user_id)
        context = {
            "received_at": turn.created_at.isoformat(),
            "timezone": prefs.timezone,
            "commute_time": prefs.commute_time,
            "commute_days": prefs.commute_days,
            "parking_lead_minutes": prefs.parking_lead_minutes,
            "catalog": CATALOG,
            "features": [
                dict(id=str(f.id), title=f.title, version=f.version, description=f.description)
                for f in session.scalars(
                    select(Feature)
                    .where(
                        Feature.user_id == user_id,
                        Feature.status == "active",
                        Feature.deleted_at.is_(None),
                    )
                    .order_by(Feature.id)
                    .limit(50)
                )
            ],
        }
        if turn.feature_id:
            executable(session, user_id, turn.feature_id)
            context["selected_feature"] = turn.feature_snapshot
            zone = ZoneInfo(prefs.timezone)
            today = turn.created_at.astimezone(zone).date()
            start = datetime.combine(today, time.min, tzinfo=zone)
            end = datetime.combine(today + timedelta(days=1), time.min, tzinfo=zone)
            rows = list(
                session.scalars(
                    select(Note)
                    .where(
                        Note.user_id == user_id,
                        Note.deleted_at.is_(None),
                        Note.created_at >= start,
                        Note.created_at < end,
                    )
                    .order_by(Note.created_at.desc(), Note.id)
                    .limit(21)
                )
            )
            context["today_notes"] = [
                dict(id=str(n.id), title=n.title, body=n.body[:2000]) for n in rows[:20]
            ]
            context["notes_truncated"] = len(rows) > 20 or any(
                len(n.body) > 2000 for n in rows[:20]
            )
        return json.dumps(context, ensure_ascii=False)
