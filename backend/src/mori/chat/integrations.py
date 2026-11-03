"""Fetch built-in data before the chat transaction and publish only after its fences."""

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select

from mori.chat import store
from mori.errors import ApiError
from mori.features.schemas import Schedule
from mori.features.service import normalize_schedule
from mori.integrations.market import fetch_market
from mori.integrations.models import MarketWatch, NewsBriefing
from mori.integrations.news import (
    Summary,
    begin_briefing,
    fetch_articles,
    store_briefing,
    summarize_articles,
)
from mori.integrations.schemas import NewsArticle, QuoteRead
from mori.organizer.service import check_revision


@dataclass(frozen=True)
class PreparedIntegration:
    action: str
    feature_id: UUID | None = None
    generation: int | None = None
    collected_at: datetime | None = None
    articles: tuple[NewsArticle, ...] = ()
    summary: Summary | None = None
    quote: QuoteRead | None = None


def check_news(session, user_id, payload, *, prepared=None):
    from mori.integrations.service import news_feature

    feature = news_feature(session, user_id, lock=prepared is not None)
    if feature is None:
        if payload.revision != 0:
            raise ApiError(409, "REVISION_CONFLICT", "뉴스 설정을 다시 조회해 주세요.")
    else:
        check_revision(feature, payload.revision)
        if feature.status != "active":
            raise ApiError(409, "FEATURE_NOT_ACTIVE", "뉴스 기능을 활성화해 주세요.")
    row = (
        session.get(NewsBriefing, feature.id, with_for_update=prepared is not None)
        if feature
        else None
    )
    feature_id, generation = feature.id if feature else None, row.generation if row else None
    collected_at = row.collected_at if row else None
    if prepared and (
        prepared.feature_id != feature_id
        or prepared.generation != generation
        or prepared.collected_at != collected_at
    ):
        raise ApiError(409, "NEWS_REFRESH_SUPERSEDED", "새로운 뉴스 수집이 먼저 반영되었습니다.")
    return feature_id, generation, collected_at


def preparation_context(factory, run_id, user_id, decision, lease_token):
    with factory.begin() as session:
        turn, _ = store.checked_turn(session, run_id, lease_token)
        store.owned(session, turn.conversation_id, user_id)
        if turn.feature_id:
            from mori.features.policy import permitted_actions

            permitted_actions(turn.feature_snapshot, decision)
        if decision.action == "news_refresh":
            return check_news(session, user_id, decision.news)
        row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
        if row is None:
            if decision.market.revision != 0:
                raise ApiError(409, "REVISION_CONFLICT", "관심 종목을 다시 조회해 주세요.")
        else:
            check_revision(row, decision.market.revision)
    return None, None, None


async def prepare(
    factory, settings, run_id, user_id, decision, *, lease_token=None, transport=None
):
    if decision.action not in {"news_refresh", "market_lookup"}:
        return None
    feature_id, generation, collected_at = await asyncio.to_thread(
        preparation_context, factory, run_id, user_id, decision, lease_token
    )
    if decision.action == "news_refresh":
        if not settings.searxng_base_url:
            raise ApiError(503, "NEWS_NOT_CONFIGURED", "뉴스 검색 연결이 설정되지 않았습니다.")
        articles = await fetch_articles(settings, decision.news.topic, transport=transport)
        # Do not start a second external request after cancellation or a replacement refresh.
        current = await asyncio.to_thread(
            preparation_context, factory, run_id, user_id, decision, lease_token
        )
        if current != (feature_id, generation, collected_at):
            raise ApiError(409, "NEWS_REFRESH_SUPERSEDED", "새로운 뉴스 수집이 시작되었습니다.")
        summary = await summarize_articles(
            factory, settings, user_id, decision.news.topic, articles, transport=transport
        )
        return PreparedIntegration(
            action=decision.action,
            feature_id=feature_id,
            generation=generation,
            collected_at=collected_at,
            articles=tuple(articles),
            summary=summary,
        )
    quote = await fetch_market(settings, decision.market.symbol, transport=transport)
    return PreparedIntegration(action=decision.action, quote=quote)


def perform(session, user_id, decision, settings, prepared=None):
    from mori.integrations.service import (
        market_settings_read,
        news_feature,
        news_read,
        save_market_settings,
        save_news_settings,
        store_market_snapshot,
    )

    if settings is None:
        raise ApiError(503, "INTEGRATIONS_NOT_CONFIGURED", "기본 기능 실행 환경이 필요합니다.")
    if decision.action in {"news_refresh", "market_lookup"} and (
        prepared is None or prepared.action != decision.action
    ):
        raise ApiError(502, "INTEGRATION_RESULT_MISSING", "조회 결과를 확인하지 못했습니다.")
    if decision.action.startswith("news_"):
        if decision.action == "news_refresh":
            check_news(session, user_id, decision.news, prepared=prepared)
        current = news_feature(session, user_id, lock=True)
        payload = decision.news
        if not {"schedule", "time"} & payload.model_fields_set:
            if current and current.schedule:
                # A request for this briefing must not discard an existing recurring schedule.
                payload = payload.model_copy(
                    update={"schedule": Schedule.model_validate(current.schedule)}
                )
        if (
            decision.action == "news_refresh"
            and current
            and current.work == payload.topic
            and current.schedule
            == normalize_schedule(session, user_id, payload.schedule, previous=current.schedule)
        ):
            # Refreshing data is not a definition edit and must not invalidate scheduled jobs.
            feature = current
        else:
            feature = save_news_settings(session, user_id, payload)
        if decision.action == "news_refresh":
            begin_briefing(session, feature)
            store_briefing(session, feature, prepared.articles, summary=prepared.summary)
        result = news_read(session, feature, settings).model_dump(mode="json")
        result["id"] = str(feature.id)
        if decision.action == "news_settings":
            answer = "뉴스 주제와 수집 시간 설정을 저장했어요."
            if not result["configured"] or not settings.automation_enabled:
                answer += " 기능 상세에서 연결과 자동 실행 가능 상태를 확인해 주세요."
        elif result["result_is_stale"]:
            answer = "새 요약을 만들지 못해 이전 브리핑을 유지했어요.\n" + result["summary_text"]
        elif result["summary_text"]:
            answer = result["summary_text"]
        elif result["articles"]:
            answer = "뉴스 기사를 수집했어요. 검색 발췌문이며 기사 전문 요약은 아닙니다.\n"
            answer += "\n".join(
                f"- {article['title']}\n  {article['summary']}\n  {article['url']}"
                for article in result["articles"]
            )
        else:
            answer = "요청한 주제로 찾은 뉴스 기사가 없어요."
        return answer, result
    row = save_market_settings(session, user_id, decision.market, settings)
    if decision.action == "market_lookup":
        store_market_snapshot(row, prepared.quote, datetime.now(UTC))
        result = {
            **prepared.quote.model_dump(mode="json"),
            "id": str(row.id),
            "revision": row.revision,
        }
        kind = "종가" if prepared.quote.price_kind == "close" else "시세"
        answer = (
            f"{row.symbol} {kind}는 {prepared.quote.price:,.2f} {prepared.quote.currency}입니다. "
            f"기준 시각: {prepared.quote.as_of.isoformat()}. 제공자: {prepared.quote.provider}."
        )
    else:
        result = market_settings_read(session, user_id, settings).model_dump(mode="json")
        result["id"] = str(row.id)
        answer = f"관심 종목을 {row.symbol}(으)로 저장했어요."
        if "schedule" in decision.market.model_fields_set:
            answer += " 예약 시간 설정도 반영했어요."
            answer += " 기능 상세에서 자동 실행 가능 상태를 확인해 주세요."
    return answer, result
