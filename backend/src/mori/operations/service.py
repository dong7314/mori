from datetime import UTC, datetime, timedelta

from sqlalchemy.dialects.postgresql import insert

from mori.operations.models import WorkerHeartbeat


def enabled_worker_components(settings):
    enabled = {
        "chat": settings.chat_worker_enabled,
        "automation": settings.automation_enabled,
        "push": settings.push_enabled,
        "documents": settings.documents_enabled,
        "billing": settings.billing_enabled,
    }
    return [name for name, on in enabled.items() if on]


def heartbeat(factory, component, *, success=False, error_code=None):
    now = datetime.now(UTC)
    values = dict(component=component, seen_at=now, error_code=error_code)
    if success:
        values["success_at"] = now
    with factory.begin() as session:
        session.execute(
            insert(WorkerHeartbeat)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["component"],
                set_={k: v for k, v in values.items() if k != "component"},
            )
        )


def worker_status(session, component, *, max_age=90, now=None):
    now = now or datetime.now(UTC)
    row = session.get(WorkerHeartbeat, component)
    live = bool(row and row.seen_at >= now - timedelta(seconds=max_age))
    return dict(
        status="unavailable" if not live else ("degraded" if row.error_code else "running"),
        last_seen_at=row.seen_at if row else None,
        last_success_at=row.success_at if row else None,
    )
