import json
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from mori.artifacts.models import DocumentJob, StoredFile
from mori.chat.models import ChatTurn
from mori.features.models import Feature
from mori.features.service import CATALOG, executable
from mori.integrations.models import MarketWatch
from mori.organizer.models import CalendarEvent, Document, Note
from mori.organizer.service import assistant_preferences
from mori.parking.models import ParkingRecord


def execution_context(factory, user_id, run_id, *, attachments=None, reference_at=None):
    with factory() as session:
        turn = session.get(ChatTurn, run_id)
        from mori.chat.attachments import validate_attachments

        validate_attachments(session, user_id, turn.attachments)
        reference_at = reference_at or turn.created_at
        prefs = assistant_preferences(session, user_id)
        features = list(
            session.scalars(
                select(Feature)
                .where(
                    Feature.user_id == user_id,
                    Feature.builtin_key.is_(None),
                    Feature.deleted_at.is_(None),
                )
                .order_by(Feature.id)
                .limit(51)
            )
        )
        context = {
            "received_at": turn.created_at.isoformat(),
            "reference_at": reference_at.isoformat(),
            "attachments": attachments or [],
            "timezone": prefs.timezone,
            "execution_timezone": prefs.timezone,
            "commute_time": prefs.commute_time,
            "commute_days": prefs.commute_days,
            "parking_lead_minutes": prefs.parking_lead_minutes,
            "catalog": CATALOG,
            "features": [
                dict(
                    id=str(f.id),
                    title=f.title,
                    version=f.version,
                    description=f.description,
                    status=f.status,
                )
                for f in features[:50]
            ],
        }
        news = session.scalar(
            select(Feature).where(
                Feature.user_id == user_id,
                Feature.builtin_key == "news",
                Feature.deleted_at.is_(None),
            )
        )
        market = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
        stock = session.scalar(
            select(Feature).where(
                Feature.user_id == user_id,
                Feature.builtin_key == "stock",
                Feature.deleted_at.is_(None),
            )
        )
        context["news_settings"] = {
            "revision": news.revision if news else 0,
            "topic": news.work if news else None,
            "schedule": news.schedule if news else None,
            "status": news.status if news else None,
        }
        context["market_settings"] = {
            "revision": market.revision if market else 0,
            "symbol": market.symbol if market else None,
            "schedule": stock.schedule if stock else None,
            "feature_revision": stock.revision if stock else None,
            "feature_status": stock.status if stock else None,
        }
        context["market_symbols"] = {"삼성전자": "005930", "코스피": "^KS11", "애플": "AAPL"}
        # Bounded, explicitly user-owned context. Contents are data, never tool instructions.
        notes = list(
            session.scalars(
                select(Note)
                .where(Note.user_id == user_id, Note.deleted_at.is_(None))
                .order_by(Note.updated_at.desc(), Note.id)
                .limit(11)
            )
        )
        context["recent_notes"] = [
            {"id": str(n.id), "title": n.title, "body": n.body[:1000]} for n in notes[:10]
        ]
        events = list(
            session.scalars(
                select(CalendarEvent)
                .where(
                    CalendarEvent.user_id == user_id,
                    CalendarEvent.deleted_at.is_(None),
                    CalendarEvent.ends_at >= reference_at,
                    CalendarEvent.starts_at < reference_at + timedelta(days=30),
                )
                .order_by(CalendarEvent.starts_at, CalendarEvent.id)
                .limit(21)
            )
        )
        context["upcoming_events"] = [
            {
                "id": str(e.id),
                "title": e.title,
                "starts_at": e.starts_at.isoformat(),
                "ends_at": e.ends_at.isoformat(),
                "timezone": e.timezone,
                "place": e.place,
                "memo": e.memo[:500],
            }
            for e in events[:20]
        ]
        documents = list(
            session.execute(
                select(Document.id, Document.title, Document.filename)
                .where(Document.user_id == user_id, Document.deleted_at.is_(None))
                .order_by(Document.updated_at.desc(), Document.id)
                .limit(11)
            ).all()
        )
        context["recent_documents"] = [
            {"id": str(d.id), "title": d.title, "filename": d.filename} for d in documents[:10]
        ]
        files = list(
            session.execute(
                select(StoredFile.id, StoredFile.filename, StoredFile.media_type)
                .where(StoredFile.user_id == user_id, StoredFile.deleted_at.is_(None))
                .order_by(StoredFile.created_at.desc(), StoredFile.id)
                .limit(11)
            ).all()
        )
        context["files"] = [
            {"id": str(f.id), "filename": f.filename, "media_type": f.media_type}
            for f in files[:10]
        ]
        reads = list(
            session.scalars(
                select(DocumentJob)
                .join(StoredFile, StoredFile.id == DocumentJob.source_file_id)
                .where(
                    DocumentJob.user_id == user_id,
                    StoredFile.user_id == user_id,
                    StoredFile.deleted_at.is_(None),
                    DocumentJob.status == "completed",
                    DocumentJob.operation == "read",
                )
                .order_by(DocumentJob.completed_at.desc(), DocumentJob.id)
                .limit(3)
            )
        )
        context["recent_document_reads"] = []
        for row in reads:
            preview = json.dumps((row.result or {}).get("data", {}), ensure_ascii=False)
            context["recent_document_reads"].append(
                {
                    "job_id": str(row.id),
                    "file_id": str(row.source_file_id),
                    "extracted_data_preview": preview[:3000],
                    "preview_truncated": len(preview) > 3000,
                }
            )
        parking = session.scalar(
            select(ParkingRecord)
            .where(ParkingRecord.user_id == user_id)
            .order_by(ParkingRecord.recorded_at.desc(), ParkingRecord.id.desc())
            .limit(1)
        )
        context["latest_parking"] = (
            None
            if parking is None
            else {
                "floor": parking.floor,
                "zone": parking.zone,
                "spot": parking.spot,
                "recorded_at": parking.recorded_at.isoformat(),
                "display_mode": parking.display_mode,
            }
        )
        context["context_limits"] = {
            "features_truncated": len(features) > 50,
            "recent_notes_truncated": len(notes) > 10
            or any(len(n.body) > 1000 for n in notes[:10]),
            "upcoming_days": 30,
            "upcoming_events_truncated": len(events) > 20,
            "documents_truncated": len(documents) > 10,
            "documents_metadata_only": True,
            "files_truncated": len(files) > 10,
        }
        if turn.feature_id:
            executable(session, user_id, turn.feature_id)
            context["selected_feature"] = turn.feature_snapshot
            schedule = (turn.feature_snapshot or {}).get("schedule") or {}
            zone = ZoneInfo(schedule.get("timezone") or prefs.timezone)
            context["execution_timezone"] = str(zone)
            today = reference_at.astimezone(zone).date()
            start = datetime.combine(today, time.min, tzinfo=zone)
            end = datetime.combine(today + timedelta(days=1), time.min, tzinfo=zone)
            context["notes_window"] = {
                "from": start.isoformat(),
                "until": end.isoformat(),
                "timezone": str(zone),
            }
            rows = list(
                session.scalars(
                    select(Note)
                    .where(
                        Note.user_id == user_id,
                        Note.deleted_at.is_(None),
                        Note.updated_at >= start,
                        Note.updated_at < end,
                    )
                    .order_by(Note.updated_at.desc(), Note.id)
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
