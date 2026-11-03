import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic import SecretStr
from test_chat import SECRET, Agent, conversation

from mori.chat import jobs, store
from mori.chat.integrations import prepare
from mori.chat.models import ChatJob
from mori.chat.schemas import Decision
from mori.errors import ApiError
from mori.integrations.models import NewsBriefing


class Providers:
    def __init__(self):
        self.agent = Agent()
        self.calls = []
        self.before_return = lambda: None
        self.status = 200

    def __call__(self, request):
        if request.url.host == "hermes.test":
            return self.agent(request)
        self.calls.append(request)
        self.before_return()
        if request.url.host == "news.test":
            return httpx.Response(
                self.status,
                json={
                    "results": [
                        {
                            "url": "https://publisher.test/ai",
                            "title": "AI 발표",
                            "content": "새 연구 내용을 공개했다.",
                        }
                    ]
                },
            )
        assert request.url.host == "market.test"
        return httpx.Response(
            self.status,
            json={
                "symbol": request.url.params["symbol"],
                "currency": "KRW",
                "price": 72400,
                "previous_close": 71000,
                "as_of": datetime.now(UTC).isoformat(),
                "price_kind": "close",
                "as_of_precision": "session_date",
            },
        )


@pytest.fixture
def providers(client, accounts):
    settings = client.app.state.settings
    settings.chat_enabled = settings.chat_worker_enabled = True
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.searxng_base_url = "http://news.test"
    settings.market_data_base_url = "http://market.test"
    return Providers()


def submit(client, accounts, cid, *, key=None, feature_id=None):
    body = {"message": "요청한 기본 기능을 실행해 줘"}
    if feature_id:
        body["feature_id"] = feature_id
    response = client.post(
        f"/v1/conversations/{cid}/runs",
        json=body,
        headers={**accounts["alice"]["headers"], "Idempotency-Key": str(key or uuid4())},
    )
    assert response.status_code == 202, response.text
    return response.json()


def run(client, accounts, providers, decision, *, cid=None, key=None, feature_id=None):
    cid = cid or conversation(client, accounts)
    providers.agent.decision = decision
    accepted = submit(client, accounts, cid, key=key, feature_id=feature_id)
    asyncio.run(
        jobs.run_chat_once(
            client.app.state.session_factory,
            client.app.state.settings,
            transport=httpx.MockTransport(providers),
        )
    )
    result = client.get(accepted["status_url"], headers=accounts["alice"]["headers"]).json()
    return result, accepted, cid


def news_payload(revision=0):
    return {"revision": revision, "topic": "AI", "time": "09:00"}


def test_chat_news_settings_persist_schedule_and_replay_without_duplicate_version(
    client, accounts, providers
):
    h = accounts["alice"]["headers"]
    key = uuid4()
    decision = {"action": "news_settings", "news": news_payload()}
    result, accepted, cid = run(client, accounts, providers, decision, key=key)
    assert result["status"] == "completed", result
    news = client.get("/v1/news", headers=h).json()
    assert news["topic"] == "AI" and news["schedule"]["time"] == "09:00"
    assert news["schedule"]["repeat"] == "daily"
    ref = next(e["result_ref"] for e in result["events"] if e.get("result_ref"))
    assert ref["kind"] == "news" and ref["detail_url"] == "/v1/news"
    replay = submit(client, accounts, cid, key=key)
    assert replay == accepted
    assert client.get("/v1/news", headers=h).json() == news
    assert client.get("/v1/news", headers=accounts["bob"]["headers"]).json()["revision"] == 0
    assert providers.calls == []

    result, _, _ = run(
        client,
        accounts,
        providers,
        {"action": "news_settings", "news": {**news_payload(news["revision"]), "topic": "과학"}},
        cid=cid,
    )
    assert result["status"] == "completed", result
    request = next(r for r in reversed(providers.agent.requests) if r.url.path != "/v1/toolsets")
    instructions = json.loads(request.content)["instructions"]
    context = json.loads(instructions.split("Mori 사용자 문맥(JSON 데이터):\n", 1)[1])
    assert context["news_settings"]["revision"] == news["revision"]
    assert context["news_settings"]["topic"] == "AI"
    assert client.get("/v1/news", headers=h).json()["topic"] == "과학"


def test_chat_market_lookup_saves_watch_snapshot_and_keeps_schedule(client, accounts, providers):
    h = accounts["alice"]["headers"]
    result, _, _ = run(
        client,
        accounts,
        providers,
        {
            "action": "market_settings",
            "market": {
                "revision": 0,
                "symbol": "005930",
                "schedule": {"time": "13:00", "repeat": "weekdays"},
            },
        },
    )
    assert result["status"] == "completed", result
    watch = client.get("/v1/market/settings", headers=h).json()
    assert watch["symbol"] == "005930" and watch["schedule"]["time"] == "13:00"
    feature = client.get("/v1/features/" + watch["feature_id"], headers=h).json()
    assert feature["builtin_key"] == "stock" and feature["schedule"]["repeat"] == "weekdays"
    result, _, _ = run(
        client,
        accounts,
        providers,
        {"action": "market_lookup", "market": {"revision": watch["revision"], "symbol": "005930"}},
    )
    assert result["status"] == "completed", result
    assert "종가" in result["answer"] and "72,400.00" in result["answer"]
    assert client.get("/v1/market/snapshot", headers=h).json()["price"] == 72400
    assert client.get("/v1/market/settings", headers=h).json()["schedule"] == watch["schedule"]
    assert (
        client.get("/v1/market/settings", headers=accounts["bob"]["headers"]).json()["symbol"]
        is None
    )


def test_chat_news_refresh_publishes_sources_and_replay_does_not_fetch_again(
    client, accounts, providers
):
    key = uuid4()
    result, accepted, cid = run(
        client, accounts, providers, {"action": "news_refresh", "news": news_payload()}, key=key
    )
    assert result["status"] == "completed", result
    assert "https://publisher.test/ai" in result["answer"]
    news = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert news["status"] == "ready" and len(news["articles"]) == 1
    assert news["summary_kind"] is None and "검색 발췌문" in result["answer"]
    assert submit(client, accounts, cid, key=key) == accepted
    assert len(providers.calls) == 1


@pytest.mark.parametrize("action", ["news_settings", "news_refresh"])
def test_chat_news_omitted_schedule_preserves_existing_schedule(
    client, accounts, providers, action
):
    h = accounts["alice"]["headers"]
    original = client.put("/v1/news/settings", json=news_payload(), headers=h).json()
    result, _, _ = run(
        client,
        accounts,
        providers,
        {"action": action, "news": {"revision": 1, "topic": "AI"}},
    )
    assert result["status"] == "completed", result
    preserved = client.get("/v1/news", headers=h).json()
    assert preserved["schedule"] == original["schedule"]
    result, _, _ = run(
        client,
        accounts,
        providers,
        {
            "action": action,
            "news": {
                "revision": preserved["revision"],
                "topic": "AI",
                "schedule": None,
            },
        },
    )
    assert result["status"] == "completed", result
    assert client.get("/v1/news", headers=h).json()["schedule"] is None


@pytest.mark.parametrize("explicit_schedule", [False, True])
def test_news_refresh_does_not_edit_unchanged_feature_definition(
    client, accounts, providers, explicit_schedule
):
    h = accounts["alice"]["headers"]
    original = client.put("/v1/news/settings", json=news_payload(), headers=h).json()
    feature_url = "/v1/features/" + original["feature_id"]
    before = client.get(feature_url, headers=h).json()
    payload = {"revision": original["revision"], "topic": original["topic"]}
    if explicit_schedule:
        payload["schedule"] = original["schedule"]
    result, _, _ = run(client, accounts, providers, {"action": "news_refresh", "news": payload})
    assert result["status"] == "completed", result
    assert client.get(feature_url, headers=h).json() == before
    assert client.get("/v1/news", headers=h).json()["status"] == "ready"


def test_builtin_settings_batch_rolls_back_and_success_replays_atomically(
    client, accounts, providers
):
    h = accounts["alice"]["headers"]
    original_watch = client.put(
        "/v1/market/settings", json={"revision": 0, "symbol": "005930"}, headers=h
    ).json()
    decision = {
        "action": "batch",
        "actions": [
            {"action": "news_settings", "news": news_payload()},
            {"action": "market_settings", "market": {"revision": 0, "symbol": "AAPL"}},
        ],
    }
    failed, _, _ = run(client, accounts, providers, decision)
    assert failed["status"] == "failed", failed
    assert client.get("/v1/news", headers=h).json()["revision"] == 0
    assert client.get("/v1/market/settings", headers=h).json() == original_watch
    assert not any(e["type"] == "action.completed" for e in failed["events"])

    decision["actions"][1]["market"]["revision"] = original_watch["revision"]
    key = uuid4()
    success, accepted, cid = run(client, accounts, providers, decision, key=key)
    assert success["status"] == "completed", success
    news = client.get("/v1/news", headers=h).json()
    market = client.get("/v1/market/settings", headers=h).json()
    assert news["topic"] == "AI" and market["symbol"] == "AAPL"
    assert len([e for e in success["events"] if e["type"] == "action.completed"]) == 2
    assert submit(client, accounts, cid, key=key) == accepted
    assert client.get("/v1/news", headers=h).json() == news
    assert client.get("/v1/market/settings", headers=h).json() == market


@pytest.mark.parametrize("action", ["news_refresh", "market_lookup"])
@pytest.mark.parametrize("failure", ["not_configured", "provider_failed"])
def test_chat_builtin_provider_failure_does_not_claim_or_save_success(
    client, accounts, providers, action, failure
):
    settings = client.app.state.settings
    if failure == "not_configured":
        if action == "news_refresh":
            settings.searxng_base_url = ""
        else:
            settings.market_data_base_url = ""
    else:
        providers.status = 503
    decision = (
        {"action": action, "news": news_payload()}
        if action == "news_refresh"
        else {"action": action, "market": {"revision": 0, "symbol": "005930"}}
    )
    result, _, _ = run(client, accounts, providers, decision)
    assert result["status"] == "failed" and result["answer"] is None, result
    assert not any(e["type"] == "action.completed" for e in result["events"])
    h = accounts["alice"]["headers"]
    assert client.get("/v1/news", headers=h).json()["revision"] == 0
    assert client.get("/v1/market/settings", headers=h).json()["revision"] == 0


@pytest.mark.parametrize("change", ["revision", "paused", "generation", "collection", "cancelled"])
def test_chat_news_refresh_rechecks_state_before_publishing(
    client, accounts, providers, sessions, change
):
    h = accounts["alice"]["headers"]
    original = client.put("/v1/news/settings", json=news_payload(), headers=h).json()
    feature_id = UUID(original["feature_id"])
    with sessions.begin() as session:
        session.add(NewsBriefing(feature_id=feature_id, feature_revision=1, generation=1))
    cid = conversation(client, accounts)
    providers.agent.decision = {"action": "news_refresh", "news": news_payload(1)}
    accepted = submit(client, accounts, cid)

    def mutate():
        if change == "revision":
            response = client.put(
                "/v1/news/settings", json={**news_payload(1), "topic": "과학"}, headers=h
            )
            assert response.status_code == 200
        elif change == "paused":
            response = client.post(
                f"/v1/features/{feature_id}/state",
                json={"revision": 1, "status": "paused"},
                headers=h,
            )
            assert response.status_code == 200
        elif change in {"generation", "collection"}:
            with sessions.begin() as session:
                row = session.get(NewsBriefing, feature_id)
                if change == "generation":
                    row.generation += 1
                else:
                    row.collected_at = datetime.now(UTC)
        else:
            assert client.post(accepted["status_url"] + "/cancel", headers=h).status_code == 200

    providers.before_return = mutate
    asyncio.run(
        jobs.run_chat_once(
            sessions, client.app.state.settings, transport=httpx.MockTransport(providers)
        )
    )
    result = client.get(accepted["status_url"], headers=h).json()
    assert result["status"] == ("interrupted" if change == "cancelled" else "failed"), result
    assert result["answer"] is None
    assert client.get("/v1/news", headers=h).json()["articles"] == []


def test_chat_market_concurrent_watch_change_does_not_publish_old_quote(
    client, accounts, providers
):
    h = accounts["alice"]["headers"]
    assert (
        client.put(
            "/v1/market/settings", json={"revision": 0, "symbol": "005930"}, headers=h
        ).status_code
        == 200
    )

    def change_watch():
        assert (
            client.put(
                "/v1/market/settings", json={"revision": 1, "symbol": "AAPL"}, headers=h
            ).status_code
            == 200
        )

    providers.before_return = change_watch
    result, _, _ = run(
        client,
        accounts,
        providers,
        {"action": "market_lookup", "market": {"revision": 1, "symbol": "005930"}},
    )
    assert result["status"] == "failed", result
    assert client.get("/v1/market/settings", headers=h).json()["symbol"] == "AAPL"
    assert client.get("/v1/market/snapshot", headers=h).json() is None


def test_chat_lookup_lost_lease_cannot_publish_prepared_result(
    client, accounts, providers, sessions
):
    cid = conversation(client, accounts)
    accepted = submit(client, accounts, cid)
    claim = jobs.claim_next(sessions, client.app.state.settings)
    decision = Decision(action="market_lookup", market={"revision": 0, "symbol": "005930"})
    prepared = asyncio.run(
        prepare(
            sessions,
            client.app.state.settings,
            claim.run_id,
            claim.user_id,
            decision,
            lease_token=claim.token,
            transport=httpx.MockTransport(providers),
        )
    )
    with sessions.begin() as session:
        session.get(ChatJob, claim.run_id).lease_token = uuid4()
    with pytest.raises(ApiError, match="CHAT_LEASE_LOST") as error:
        store.finish(
            sessions,
            claim.run_id,
            claim.user_id,
            decision,
            lease_token=claim.token,
            settings=client.app.state.settings,
            prepared=prepared,
        )
    assert error.value.code == "CHAT_LEASE_LOST"
    h = accounts["alice"]["headers"]
    assert client.get("/v1/market/settings", headers=h).json()["revision"] == 0
    assert client.get(accepted["status_url"], headers=h).json()["answer"] is None


@pytest.mark.parametrize(
    "action", ["news_settings", "news_refresh", "market_settings", "market_lookup"]
)
def test_custom_feature_cannot_gain_builtin_settings_permission(
    client, accounts, providers, action
):
    h = accounts["alice"]["headers"]
    feature = client.post(
        "/v1/features",
        json={"work": "기본 기능 설정 바꾸기"},
        headers={**h, "Idempotency-Key": str(uuid4())},
    ).json()
    decision = (
        {"action": action, "news": news_payload()}
        if action.startswith("news_")
        else {"action": action, "market": {"revision": 0, "symbol": "005930"}}
    )
    result, _, _ = run(client, accounts, providers, decision, feature_id=feature["id"])
    assert result["status"] == "failed", result
    assert result["events"][-1]["code"] == "FEATURE_ACTION_NOT_ALLOWED"
    assert providers.calls == []
    assert client.get("/v1/news", headers=h).json()["revision"] == 0
    assert client.get("/v1/market/settings", headers=h).json()["revision"] == 0
