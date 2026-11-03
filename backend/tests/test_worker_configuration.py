import asyncio
import json
import sys
import threading
from uuid import uuid4

import pytest
from pydantic import SecretStr

from mori import worker


def create_feature(client, accounts, payload):
    response = client.post(
        "/v1/features",
        json=payload,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_capabilities_follow_configured_providers_and_account_runtime(client, accounts):
    h = accounts["alice"]["headers"]
    caps = client.get("/v1/feature-catalog", headers=h).json()["capabilities"]
    assert not any(
        caps[key]
        for key in (
            "scheduled_execution",
            "push_delivery",
            "market_data",
            "custom_chat_execution",
            "news_collection",
        )
    )
    settings = client.app.state.settings
    settings.automation_enabled = True
    settings.searxng_base_url = "http://search.test"
    settings.market_data_base_url = "https://market.test"
    settings.chat_enabled = True
    caps = client.get("/v1/feature-catalog", headers=h).json()["capabilities"]
    assert caps["scheduled_execution"] and caps["news_collection"] and caps["market_data"]
    assert not caps["custom_chat_execution"]  # No runtime has been assigned to this account.
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr("configured-key")
    assert not client.get("/v1/feature-catalog", headers=h).json()["capabilities"][
        "custom_chat_execution"
    ]
    settings.chat_worker_enabled = True
    assert client.get("/v1/feature-catalog", headers=h).json()["capabilities"][
        "custom_chat_execution"
    ]
    assert not client.get("/v1/feature-catalog", headers=accounts["bob"]["headers"]).json()[
        "capabilities"
    ]["custom_chat_execution"]


def test_feature_automation_status_and_dashboard_use_provider_specific_readiness(client, accounts):
    h = accounts["alice"]["headers"]
    settings = client.app.state.settings
    settings.automation_enabled = True
    settings.searxng_base_url = "http://search.test"
    news = create_feature(
        client,
        accounts,
        {
            "title": "과학 뉴스",
            "work": "과학",
            "builtin_key": "news",
            "schedule": {"time": "09:00", "repeat": "daily"},
        },
    )
    custom = create_feature(
        client,
        accounts,
        {
            "title": "메모 정리",
            "work": "메모 정리",
            "schedule": {"time": "09:00", "repeat": "daily"},
        },
    )
    stock = create_feature(
        client,
        accounts,
        {
            "title": "시세",
            "work": "주가",
            "builtin_key": "stock",
            "schedule": {"time": "09:00", "repeat": "daily"},
        },
    )
    assert news["automation_status"] == "configured"
    assert not news["execution_available"]  # Chat is a separate entry point from news refresh.
    assert custom["automation_status"] == "not_configured"
    assert stock["automation_status"] == "not_configured"
    settings.market_data_base_url = "https://market.test"
    assert (
        client.get(f"/v1/features/{stock['id']}", headers=h).json()["automation_status"]
        == "configured"
    )
    response = client.get("/v1/dashboard", headers=h, params={"at": "2090-11-01T09:10:00+09:00"})
    assert response.status_code == 200, response.text
    rows = {
        row["resource_id"]: row for group in response.json()["groups"] for row in group["items"]
    }
    assert rows[news["id"]]["availability"] == "automation_configured"
    assert rows[stock["id"]]["availability"] == "automation_configured"
    assert rows[custom["id"]]["availability"] == "automation_not_configured"


def test_worker_requires_explicit_enablement(settings):
    with pytest.raises(ValueError, match="Enable MORI_"):
        asyncio.run(worker.run_cycle(None, settings))
    with pytest.raises(ValueError, match="Enable MORI_"):
        asyncio.run(worker.run_worker(None, settings))


def test_worker_does_not_delay_notification_dispatch_until_ai_finishes(settings, monkeypatch):
    settings.automation_enabled = True
    notifications_started = threading.Event()
    order = []

    async def slow_ai(*args):
        assert await asyncio.to_thread(notifications_started.wait, 2)
        order.append("ai_finished")
        return True

    def notify(*args):
        order.append("notification_sent")
        notifications_started.set()
        return {"sent": 1}

    monkeypatch.setattr(worker, "run_once", slow_ai)
    monkeypatch.setattr(worker, "deliver_due", notify)
    result = asyncio.run(worker.run_cycle(None, settings))
    assert result == {"automation_processed": True, "notifications": {"sent": 1}}
    assert order == ["notification_sent", "ai_finished"]


@pytest.mark.parametrize("component", ["chat", "documents", "billing"])
def test_worker_health_defaults_to_enabled_components(
    settings, sessions, monkeypatch, capsys, component, isolated_heartbeats
):
    from mori import cli
    from mori.operations.service import heartbeat

    flag = "chat_worker_enabled" if component == "chat" else component + "_enabled"
    setattr(settings, flag, True)
    heartbeat(sessions, component, success=True)
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    monkeypatch.setattr(sys, "argv", ["mori", "worker-health"])
    cli.main()
    assert json.loads(capsys.readouterr().out) == {component: "running"}


def test_worker_health_fails_for_missing_enabled_billing_heartbeat(
    settings, sessions, monkeypatch, capsys, isolated_heartbeats
):
    from mori import cli
    from mori.operations.service import heartbeat

    # Healthy older components must not hide an enabled but absent billing worker.
    for component in ("chat", "automation", "push", "documents"):
        heartbeat(sessions, component, success=True)
    settings.billing_enabled = True
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    monkeypatch.setattr(sys, "argv", ["mori", "worker-health"])
    with pytest.raises(SystemExit) as failure:
        cli.main()
    assert failure.value.code == 1
    assert json.loads(capsys.readouterr().out) == {"billing": "unavailable"}


@pytest.fixture
def isolated_heartbeats(sessions):
    from sqlalchemy import delete

    from mori.operations.models import WorkerHeartbeat

    # Heartbeats are global records without a user FK, so user fixture cleanup
    # alone does not isolate these CLI checks from other tests.
    with sessions.begin() as session:
        session.execute(delete(WorkerHeartbeat))
    yield
    with sessions.begin() as session:
        session.execute(delete(WorkerHeartbeat))


def test_worker_health_allows_explicit_probe_but_rejects_no_enabled_components(
    settings, sessions, monkeypatch, capsys, isolated_heartbeats
):
    from mori import cli
    from mori.operations.service import heartbeat

    heartbeat(sessions, "documents", success=True)
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    monkeypatch.setattr(sys, "argv", ["mori", "worker-health", "--components", "documents"])
    cli.main()
    assert json.loads(capsys.readouterr().out) == {"documents": "running"}
    monkeypatch.setattr(sys, "argv", ["mori", "worker-health"])
    with pytest.raises(SystemExit) as failure:
        cli.main()
    assert failure.value.code == 1
    assert json.loads(capsys.readouterr().out) == {}
