import asyncio
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
