from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError, ErrorResponse
from mori.integrations.market import fetch_market
from mori.integrations.models import MarketWatch, NewsBriefing
from mori.integrations.news import (
    begin_briefing,
    fetch_articles,
    store_briefing,
    summarize_articles,
)
from mori.integrations.schemas import (
    CandlesRead,
    MarketSettings,
    MarketSettingsRead,
    NewsRead,
    NewsSettings,
    QuoteRead,
)
from mori.integrations.service import (
    chosen_symbol,
    market_settings_read,
    news_feature,
    news_read,
    recover_expired_manual_refresh,
    save_market_settings,
    save_news_settings,
)
from mori.organizer.schemas import Revision
from mori.organizer.service import check_revision, lock_user

router = APIRouter(
    prefix="/v1",
    tags=["data"],
    responses={**PRIVATE_API_RESPONSES, 502: {"model": ErrorResponse}},
)


def get_integration_transport():
    return None


Transport = Annotated[httpx.AsyncBaseTransport | None, Depends(get_integration_transport)]


@router.get("/news", response_model=NewsRead, summary="뉴스 설정 및 마지막 수집 결과")
def news(user: CurrentUser, session: DatabaseSession, request: Request):
    if recover_expired_manual_refresh(session, user.id):
        session.commit()
    return news_read(session, news_feature(session, user.id), request.app.state.settings)


@router.put("/news/settings", response_model=NewsRead, summary="관심 주제·수집 시간 저장")
def news_settings(
    payload: NewsSettings, user: CurrentUser, session: DatabaseSession, request: Request
):
    feature = save_news_settings(session, user.id, payload)
    session.commit()
    return news_read(session, feature, request.app.state.settings)


@router.post("/news/refresh", response_model=NewsRead, summary="실제 기사 재수집")
async def refresh_news(
    payload: Revision,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    transport: Transport,
):
    settings = request.app.state.settings
    if not settings.searxng_base_url:
        raise ApiError(503, "NEWS_NOT_CONFIGURED", "뉴스 검색 연결이 설정되지 않았습니다.")
    lock_user(session, user.id)
    feature = news_feature(session, user.id, lock=True)
    if feature is None:
        raise ApiError(404, "NEWS_SETTINGS_NOT_FOUND", "먼저 관심 주제를 저장해 주세요.")
    check_revision(feature, payload.revision)
    if feature.status != "active":
        raise ApiError(409, "FEATURE_NOT_ACTIVE", "뉴스 기능을 활성화해 주세요.")
    row = begin_briefing(session, feature)
    # Search is bounded to 15s and summary generation to 120s. The remaining
    # margin covers local state publication without leaving an orphaned spinner.
    deadline = datetime.now(UTC) + timedelta(seconds=180)
    row.manual_refresh_deadline = deadline
    generation, revision, feature_id, topic = (
        row.generation,
        feature.revision,
        feature.id,
        feature.work,
    )
    session.commit()
    failure = None
    try:
        articles = await fetch_articles(settings, topic, transport=transport)
    except ApiError as exc:
        failure = exc
    # Refresh ORM state after network I/O; only the latest request/version may publish.
    session.expire_all()
    if recover_expired_manual_refresh(session, user.id):
        session.commit()
    feature = news_feature(session, user.id, lock=True)
    row = session.get(NewsBriefing, feature_id, populate_existing=True, with_for_update=True)
    if (
        feature is None
        or feature.revision != revision
        or feature.status != "active"
        or row is None
        or row.generation != generation
    ):
        session.rollback()
        raise ApiError(
            409, "NEWS_REFRESH_SUPERSEDED", "뉴스 설정이 바뀌었습니다. 다시 수집해 주세요."
        )
    if failure:
        row.status, row.error_code = "failed", failure.code
        row.manual_refresh_deadline = None
        session.commit()
        raise failure
    collected_at = datetime.now(UTC)
    if not (settings.news_summary_enabled and articles and row.summary_text):
        store_briefing(session, feature, articles, collected_at)
        if settings.news_summary_enabled and articles:
            # Articles are already readable while the summary is in progress.
            # Keep the refresh lease until that final phase is published.
            row.status = "loading"
            row.manual_refresh_deadline = deadline
    session.commit()
    # Publish an initial collection immediately. When a successful summary exists,
    # retain its complete briefing until the replacement summary succeeds.
    summary = await summarize_articles(
        request.app.state.session_factory, settings, user.id, topic, articles, transport=transport
    )
    session.expire_all()
    if recover_expired_manual_refresh(session, user.id):
        session.commit()
    feature = news_feature(session, user.id, lock=True)
    row = session.get(NewsBriefing, feature_id, populate_existing=True, with_for_update=True)
    if (
        feature is None
        or feature.revision != revision
        or feature.status != "active"
        or row is None
        or row.generation != generation
    ):
        session.rollback()
        raise ApiError(
            409, "NEWS_REFRESH_SUPERSEDED", "뉴스 설정이 바뀌었습니다. 다시 수집해 주세요."
        )
    store_briefing(session, feature, articles, collected_at, summary=summary)
    session.commit()
    return news_read(session, feature, settings)


@router.get("/market/settings", response_model=MarketSettingsRead, summary="관심 종목 조회")
def market_settings(user: CurrentUser, session: DatabaseSession, request: Request):
    return market_settings_read(session, user.id, request.app.state.settings)


@router.put("/market/settings", response_model=MarketSettingsRead, summary="관심 종목 저장")
def update_market_settings(
    payload: MarketSettings,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    save_market_settings(session, user.id, payload, request.app.state.settings)
    session.commit()
    return market_settings(user, session, request)


@router.get("/market/snapshot", response_model=QuoteRead | None, summary="예약 실행의 마지막 시세")
def market_snapshot(user: CurrentUser, session: DatabaseSession):
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user.id))
    return row.snapshot if row else None


Symbol = Annotated[str | None, Query(max_length=40, pattern=r"^[A-Za-z0-9.^:_-]+$")]


@router.get("/market/quote", response_model=QuoteRead, summary="제공자 기준 시세")
async def quote(
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    transport: Transport,
    symbol: Symbol = None,
):
    symbol = chosen_symbol(session, user.id, symbol)
    session.rollback()
    return await fetch_market(request.app.state.settings, symbol, transport=transport)


@router.get("/market/candles", response_model=CandlesRead, summary="일·주·월 캔들 조회")
async def candles(
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
    transport: Transport,
    range: Literal["day", "week", "month"] = "day",
    symbol: Symbol = None,
):
    symbol = chosen_symbol(session, user.id, symbol)
    session.rollback()
    return await fetch_market(request.app.state.settings, symbol, range=range, transport=transport)
