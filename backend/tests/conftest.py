import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from mori.auth.dependencies import hash_token
from mori.auth.models import AccessToken, User
from mori.config import Settings
from mori.database import build_engine, build_session_factory
from mori.main import create_app

BACKEND_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    admin_url = os.environ.get("MORI_TEST_POSTGRES_URL")
    if not admin_url:
        raise pytest.UsageError(
            "MORI_TEST_POSTGRES_URL must point to a disposable PostgreSQL server "
            "with CREATEDB privileges; see backend/README.md."
        )
    name = f"mori_test_{uuid4().hex}"
    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT", hide_parameters=True)
    with admin.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(admin_url).set(database=name).render_as_string(hide_password=False)
    try:
        with pytest.MonkeyPatch.context() as environment:
            environment.setenv("MORI_DATABASE_URL", url)
            command.upgrade(Config(str(BACKEND_ROOT / "alembic.ini")), "head")
            yield url
    finally:
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(database_url=database_url, cors_origins=["http://localhost:5173"])


@pytest.fixture
def sessions(settings: Settings) -> Iterator[sessionmaker[Session]]:
    engine = build_engine(settings)
    with engine.begin() as connection:
        connection.execute(text("TRUNCATE parking_records, access_tokens, users CASCADE"))
    yield build_session_factory(engine)
    engine.dispose()


@pytest.fixture
def client(settings: Settings, sessions: sessionmaker[Session]) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def accounts(sessions: sessionmaker[Session]) -> dict[str, dict]:
    accounts = {}
    with sessions.begin() as session:
        for name in ("alice", "bob"):
            user = User(display_name=name)
            session.add(user)
            session.flush()
            raw_token = f"mori_test_{uuid4().hex}"
            access = AccessToken(
                user_id=user.id,
                token_hash=hash_token(raw_token),
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
            session.add(access)
            session.flush()
            accounts[name] = {
                "user_id": user.id,
                "token_id": access.id,
                "headers": {"Authorization": f"Bearer {raw_token}"},
            }
    return accounts
