import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from test_automation import create_scheduled_feature, make_news
from test_chat import SECRET, Agent

from mori.automation.models import AutomationJob
from mori.automation.scheduler import run_once
from mori.chat.models import ChatTurn
from mori.features.models import Feature
from mori.integrations.models import NewsBriefing
from mori.integrations.router import get_integration_transport

ARTICLE = {
    "title": "과학 연구 발표",
    "content": "새 연구 결과를 공개했다. 기사 전문은 검색 응답에 포함되지 않는다.",
    "url": "https://news.example.org/science",
}


@pytest.fixture
def summary_environment(client, accounts):
    settings = client.app.state.settings
    settings.searxng_base_url = "http://search.test"
    settings.news_summary_enabled = settings.chat_enabled = True
    settings.hermes_test_user_id = accounts["alice"]["user_id"]
    settings.hermes_base_url = "http://hermes.test"
    settings.hermes_api_key = SecretStr(SECRET)
    agent = Agent()
    agent.decision = {"action": "reply", "reply": "- 새 연구 결과가 발표됐어요."}
    requests = []

    def transport(request):
        requests.append(request)
        if request.url.host == "search.test":
            return httpx.Response(200, json={"results": [ARTICLE]})
        return agent(request)

    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        transport
    )
    return settings, agent, requests, transport


def settings_for(client, accounts, who="alice"):
    response = client.put(
        "/v1/news/settings", json={"revision": 0, "topic": "과학"}, headers=accounts[who]["headers"]
    )
    assert response.status_code == 200
    return response.json()


def refresh(client, accounts, who="alice"):
    return client.post("/v1/news/refresh", json={"revision": 1}, headers=accounts[who]["headers"])


def test_briefing_retains_articles_and_explicit_search_excerpt_provenance(
    client, accounts, summary_environment
):
    _, agent, requests, _ = summary_environment
    settings_for(client, accounts)
    response = refresh(client, accounts)
    assert response.status_code == 200, response.text
    row = response.json()
    assert row["status"] == row["summary_status"] == "ready"
    assert row["summary_kind"] == "ai_search_excerpt_summary"
    assert "검색 발췌문" in row["summary_text"] and ARTICLE["url"] in row["summary_text"]
    assert row["articles"][0]["summary_type"] == "search_excerpt"
    assert row["articles"][0]["summary"] == ARTICLE["content"]
    assert row["summary_error_code"] is None and SECRET not in response.text
    payload = json.loads(agent.requests[-1].content)
    assert "external_data_untrusted" in payload["instructions"]
    assert "search_result_titles_and_excerpts_only" in payload["instructions"]
    assert {r.url.path for r in requests} == {"/search", "/v1/toolsets", "/v1/responses"}
    assert client.get("/v1/news", headers=accounts["bob"]["headers"]).json()["articles"] == []


@pytest.mark.parametrize(
    "mode,code",
    [
        ("unverified_source", "UNVERIFIED_NEWS_SOURCE"),
        ("action", "INVALID_NEWS_SUMMARY"),
        ("truncated", "INVALID_AGENT_RESPONSE"),
        ("tool", "NEWS_SUMMARY_UNEXPECTED_TOOL"),
    ],
)
def test_ai_failure_does_not_discard_successfully_collected_articles(
    client, accounts, summary_environment, mode, code
):
    _, agent, _, _ = summary_environment
    settings_for(client, accounts)
    if mode == "unverified_source":
        agent.decision["reply"] = "근거 https://invented.example.net/story"
    elif mode == "action":
        agent.decision = {"action": "note_save", "note": {"title": "원치 않은 저장"}}
    elif mode == "truncated":
        agent.broken = True
    else:
        agent.prefix = [
            {
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "name": "web_search",
                    "call_id": "extra",
                    "arguments": '{"query":"not requested"}',
                },
            }
        ]
    response = refresh(client, accounts)
    assert response.status_code == 200
    row = response.json()
    assert row["status"] == "ready" and row["summary_status"] == "failed"
    assert row["summary_text"] is row["summary_kind"] is None
    assert row["summary_error_code"] == code
    assert row["articles"][0]["url"] == ARTICLE["url"]
    assert client.get("/v1/notes", headers=accounts["alice"]["headers"]).json() == []


def test_disabled_summary_and_empty_results_never_call_hermes(
    client, accounts, summary_environment
):
    settings, agent, _, _ = summary_environment
    settings_for(client, accounts)
    settings.news_summary_enabled = False
    row = refresh(client, accounts).json()
    assert row["status"] == "ready" and row["summary_status"] == "not_requested"
    assert not agent.requests
    settings.news_summary_enabled = True
    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        lambda _: httpx.Response(200, json={"results": []})
    )
    row = refresh(client, accounts).json()
    assert row["summary_status"] == "empty" and not row["articles"]
    assert not agent.requests


@pytest.mark.parametrize("scheduled", [False, True])
def test_failed_summary_refresh_retains_last_briefing_and_its_sources(
    client, accounts, sessions, summary_environment, scheduled
):
    settings, agent, _, transport = summary_environment
    now = datetime.now(UTC)
    if scheduled:
        settings.automation_enabled = True
        feature_id = create_scheduled_feature(sessions, accounts, now)
        make_news(sessions, feature_id)
    else:
        settings_for(client, accounts)
    original = refresh(client, accounts).json()
    assert original["summary_status"] == "ready"
    agent.broken = True

    def changed_articles(request):
        if request.url.host == "search.test":
            return httpx.Response(
                200, json={"results": [{**ARTICLE, "url": "https://news.example.org/new-science"}]}
            )
        return transport(request)

    if scheduled:
        assert asyncio.run(
            run_once(sessions, settings, transport=httpx.MockTransport(changed_articles), now=now)
        )
        with sessions() as session:
            job = session.scalar(
                select(AutomationJob).where(AutomationJob.feature_id == feature_id)
            )
            assert job.status == "completed"
            assert session.get(ChatTurn, job.run_id).answer == (
                "뉴스 요약을 완료하지 못해 이전 브리핑을 유지했어요."
            )
    else:
        client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
            changed_articles
        )
        assert refresh(client, accounts).status_code == 200
    state = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert state["summary_status"] == "failed"
    assert state["summary_error_code"] == "INVALID_AGENT_RESPONSE"
    assert state["summary_text"] == original["summary_text"]
    assert state["summary_kind"] == original["summary_kind"]
    assert state["articles"] == original["articles"]
    assert state["collected_at"] == original["collected_at"]
    assert state["result_is_stale"] is True
    agent.broken = False
    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        changed_articles
    )
    recovered = refresh(client, accounts).json()
    assert recovered["summary_status"] == "ready"
    assert recovered["summary_error_code"] is None and not recovered["result_is_stale"]
    assert recovered["articles"][0]["url"] == "https://news.example.org/new-science"
    assert recovered["articles"][0]["url"] in recovered["summary_text"]


def test_unassigned_free_user_keeps_articles_with_truthful_ai_unavailability(
    client, accounts, summary_environment
):
    _, agent, _, _ = summary_environment
    settings_for(client, accounts, "bob")
    response = refresh(client, accounts, "bob")
    assert response.status_code == 200
    row = response.json()
    assert row["status"] == "ready" and len(row["articles"]) == 1
    assert (
        row["summary_status"] == "failed" and row["summary_error_code"] == "CHAT_RUNTIME_REQUIRED"
    )
    assert not agent.requests


def test_config_change_during_summary_fences_old_output(
    client, accounts, sessions, summary_environment
):
    _, agent, _, transport = summary_environment
    feature_id = UUID(settings_for(client, accounts)["feature_id"])

    def changing(request):
        response = transport(request)
        if request.url.path == "/v1/responses":
            with sessions.begin() as session:
                feature = session.get(Feature, feature_id)
                feature.revision += 1
                feature.work = "다른 관심 주제"
        return response

    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        changing
    )
    response = refresh(client, accounts)
    assert response.status_code == 409
    row = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert row["revision"] == 2 and row["summary_text"] is None and row["articles"] == []


def test_newer_refresh_generation_keeps_its_summary(
    client, accounts, sessions, summary_environment
):
    _, _, _, transport = summary_environment
    feature_id = UUID(settings_for(client, accounts)["feature_id"])

    def changing(request):
        response = transport(request)
        if request.url.path == "/v1/responses":
            with sessions.begin() as session:
                row = session.get(NewsBriefing, feature_id, with_for_update=True)
                row.generation += 1
                row.summary_kind = "ai_search_excerpt_summary"
                row.summary_text = "새 요청의 요약"
        return response

    client.app.dependency_overrides[get_integration_transport] = lambda: httpx.MockTransport(
        changing
    )
    assert refresh(client, accounts).status_code == 409
    row = client.get("/v1/news", headers=accounts["alice"]["headers"]).json()
    assert row["summary_text"] == "새 요청의 요약"


@pytest.mark.parametrize("summary_fails", [False, True])
def test_scheduled_news_uses_same_summary_and_atomic_completion(
    client, accounts, sessions, summary_environment, summary_fails
):
    settings, agent, _, transport = summary_environment
    agent.broken = summary_fails
    settings.automation_enabled = True
    now = datetime.now(UTC)
    feature_id = create_scheduled_feature(sessions, accounts, now)
    make_news(sessions, feature_id)
    assert asyncio.run(
        run_once(sessions, settings, transport=httpx.MockTransport(transport), now=now)
    )
    with sessions() as session:
        row = session.get(NewsBriefing, feature_id)
        job = session.scalar(select(AutomationJob).where(AutomationJob.feature_id == feature_id))
        assert job.status == "completed"
        if summary_fails:
            assert row.summary_error == "INVALID_AGENT_RESPONSE" and row.summary_text is None
            assert session.get(ChatTurn, job.run_id).answer == (
                "기사는 수집했지만 요약을 완료하지 못했어요."
            )
        else:
            assert row.summary_kind == "ai_search_excerpt_summary"
            assert session.get(ChatTurn, job.run_id).answer == row.summary_text
        assert row.articles[0]["url"] == ARTICLE["url"]
