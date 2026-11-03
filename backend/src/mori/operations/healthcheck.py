"""Readiness check for enabled worker components; never starts jobs."""

from mori.config import Settings
from mori.database import build_engine, build_session_factory
from mori.operations.service import enabled_worker_components, worker_status


def main():
    settings = Settings()
    engine = build_engine(settings)
    try:
        with build_session_factory(engine)() as session:
            required = enabled_worker_components(settings)
            if not required or any(
                worker_status(session, name)["status"] == "unavailable" for name in required
            ):
                raise SystemExit(1)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
