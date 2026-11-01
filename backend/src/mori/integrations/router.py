from datetime import UTC, datetime
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError, ErrorResponse
from mori.features.models import Feature
from mori.features.schemas import FeatureCreate, FeatureUpdate
from mori.features.service import create_feature, update_feature
from mori.integrations.market import fetch_market
from mori.integrations.models import MarketWatch, NewsBriefing
from mori.integrations.news import fetch_articles, store_briefing
from mori.integrations.schemas import (
    CandlesRead,
    MarketSettings,
    MarketSettingsRead,
    NewsRead,
    NewsSettings,
    QuoteRead,
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


def news_feature(session, user_id, *, lock=False):
    query = select(Feature).where(
        Feature.user_id == user_id,
        Feature.builtin_key == "news",
        Feature.deleted_at.is_(None),
    )
    return session.scalar(query.with_for_update() if lock else query)


def news_read(session, feature, settings):
    if feature is None:
        return NewsRead(configured=bool(settings.searxng_base_url))
    row = session.get(NewsBriefing, feature.id)
    current = row is not None and row.feature_revision == feature.revision
    return NewsRead(
        feature_id=feature.id,
        revision=feature.revision,
        topic=feature.work,
        schedule=feature.schedule,
        configured=bool(settings.searxng_base_url),
        status=row.status if current else "empty",
        articles=row.articles if current else [],
        collected_at=row.collected_at if current else None,
        error_code=row.error_code if current else None,
    )


@router.get("/news", response_model=NewsRead, summary="뉴스 설정 및 마지막 수집 결과")
def news(user: CurrentUser, session: DatabaseSession, request: Request):
    return news_read(session, news_feature(session, user.id), request.app.state.settings)


@router.put("/news/settings", response_model=NewsRead, summary="관심 주제·수집 시간 저장")
def news_settings(
    payload: NewsSettings, user: CurrentUser, session: DatabaseSession, request: Request
):
    lock_user(session, user.id)
    feature = news_feature(session, user.id, lock=True)
    if feature is None:
        if payload.revision != 0:
            raise ApiError(409, "REVISION_CONFLICT", "뉴스 설정을 다시 조회해 주세요.")
        feature = create_feature(
            session,
            user.id,
            FeatureCreate(
                builtin_key="news",
                title="뉴스 브리핑",
                work=payload.topic,
                icon="news",
                schedule=payload.schedule,
            ),
        )
    else:
        check_revision(feature, payload.revision)
        feature = update_feature(
            session,
            user.id,
            feature.id,
            FeatureUpdate(
                revision=payload.revision,
                title=feature.title,
                description=feature.description,
                work=payload.topic,
                reference=feature.reference,
                icon=feature.icon,
                schedule=payload.schedule,
            ),
        )
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
    row = session.get(NewsBriefing, feature.id)
    if row is None:
        row = NewsBriefing(feature_id=feature.id, generation=0, articles=[])
        session.add(row)
    row.generation += 1
    row.feature_revision, row.status, row.error_code = feature.revision, "loading", None
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
    feature = news_feature(session, user.id, lock=True)
    row = session.get(NewsBriefing, feature_id, populate_existing=True)
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
        session.commit()
        raise failure
    store_briefing(session, feature, articles)
    session.commit()
    return news_read(session, feature, settings)


@router.get("/market/settings", response_model=MarketSettingsRead, summary="관심 종목 조회")
def market_settings(user: CurrentUser, session: DatabaseSession, request: Request):
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user.id))
    settings = request.app.state.settings
    return MarketSettingsRead(
        symbol=row.symbol if row else None,
        revision=row.revision if row else 0,
        configured=bool(settings.market_data_base_url),
        provider=settings.market_data_provider,
    )


@router.put("/market/settings", response_model=MarketSettingsRead, summary="관심 종목 저장")
def update_market_settings(
    payload: MarketSettings,
    user: CurrentUser,
    session: DatabaseSession,
    request: Request,
):
    lock_user(session, user.id)
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user.id))
    if row is None:
        if payload.revision != 0:
            raise ApiError(409, "REVISION_CONFLICT", "관심 종목을 다시 조회해 주세요.")
        row = MarketWatch(user_id=user.id, symbol=payload.symbol)
        session.add(row)
    else:
        check_revision(row, payload.revision)
        if row.symbol != payload.symbol:
            row.snapshot = row.collected_at = None
        row.symbol, row.revision, row.updated_at = (
            payload.symbol,
            row.revision + 1,
            datetime.now(UTC),
        )
    session.commit()
    return market_settings(user, session, request)


@router.get("/market/snapshot", response_model=QuoteRead | None, summary="예약 실행의 마지막 시세")
def market_snapshot(user: CurrentUser, session: DatabaseSession):
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user.id))
    return row.snapshot if row else None


def chosen_symbol(session, user_id, symbol):
    if symbol:
        return symbol.upper()
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
    if row is None:
        raise ApiError(422, "SYMBOL_REQUIRED", "먼저 관심 종목을 선택해 주세요.")
    return row.symbol


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
