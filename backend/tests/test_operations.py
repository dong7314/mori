import json
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select

from mori.auth.models import AccessToken
from mori.cli import main
from mori.config import Settings
from mori.main import create_app


def test_health_and_cors(client):
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").json() == {"status": "ready"}
    preflight = client.options(
        "/v1/parking-records",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,idempotency-key,content-type",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
    blocked = client.options(
        "/v1/parking-records",
        headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"},
    )
    assert "Access-Control-Allow-Origin" not in blocked.headers


def test_database_unavailable_does_not_break_liveness_or_leak_credentials():
    settings = Settings(
        database_url="postgresql+psycopg://mori:secret-not-for-output@127.0.0.1:1/mori"
    )
    with TestClient(create_app(settings)) as unavailable:
        assert unavailable.get("/health/live").status_code == 200
        ready = unavailable.get("/health/ready")
        assert ready.status_code == 503
        assert ready.json()["error"]["code"] == "DATABASE_UNAVAILABLE"
        assert "secret-not-for-output" not in ready.text


def test_cli_provisions_hashed_tokens_and_can_revoke(client, sessions, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["mori", "create-user", "--name", "개인 알파"])
    main()
    first = json.loads(capsys.readouterr().out)
    token = first["access_token"]
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid4())}
    assert (
        client.post("/v1/parking-records", headers=headers, json={"spot": "C36"}).status_code == 201
    )
    with sessions() as session:
        stored = session.scalar(select(AccessToken))
        assert stored.token_hash != token
        assert len(stored.token_hash) == 64

    monkeypatch.setattr(sys, "argv", ["mori", "issue-token", "--user-id", first["user_id"]])
    main()
    second = json.loads(capsys.readouterr().out)
    monkeypatch.setattr(sys, "argv", ["mori", "revoke-token", "--token-id", first["token_id"]])
    main()
    assert json.loads(capsys.readouterr().out)["revoked"] is True
    assert client.get("/v1/parking-records/latest", headers=headers).status_code == 401
    assert (
        client.get(
            "/v1/parking-records/latest",
            headers={"Authorization": f"Bearer {second['access_token']}"},
        ).status_code
        == 200
    )


def test_migration_matches_models_and_can_roll_back(database_url, sessions):
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.check(config)
    command.downgrade(config, "base")
    try:
        with sessions() as session:
            assert "parking_records" not in inspect(session.connection()).get_table_names()
    finally:
        command.upgrade(config, "head")


def test_openapi_contract(client):
    schema = client.get("/openapi.json").json()
    operation = schema["paths"]["/v1/parking-records"]["post"]
    assert operation["security"] == [{"HTTPBearer": []}]
    assert operation["parameters"][0]["name"] == "Idempotency-Key"
    assert set(operation["responses"]) == {"200", "201", "401", "409", "422", "503"}
    assert schema["components"]["schemas"]["ParkingCreate"]["additionalProperties"] is False


@pytest.mark.parametrize("origins", [["*"], ["http://localhost:5173", "*"]])
def test_wildcard_cors_configuration_rejected(origins):
    with pytest.raises(ValueError):
        Settings(database_url="postgresql+psycopg://mori@localhost/mori", cors_origins=origins)
