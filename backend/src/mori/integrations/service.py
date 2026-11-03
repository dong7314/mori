"""Owned integration settings shared by HTTP and transactional chat actions."""

from datetime import UTC, datetime

from sqlalchemy import select, update

from mori.errors import ApiError
from mori.features.models import Feature
from mori.features.schemas import FeatureCreate, FeatureUpdate
from mori.features.service import create_feature, update_feature
from mori.integrations.kis import instrument
from mori.integrations.market import MAX_MARKET_CLOCK_SKEW, market_configured
from mori.integrations.models import MarketWatch, NewsBriefing
from mori.integrations.schemas import MarketSettingsRead, NewsRead
from mori.organizer.service import check_revision, lock_user


def builtin_feature(session, user_id, key, *, lock=False):
    query = select(Feature).where(
        Feature.user_id == user_id,
        Feature.builtin_key == key,
        Feature.deleted_at.is_(None),
    )
    return session.scalar(query.with_for_update() if lock else query)


def news_feature(session, user_id, *, lock=False):
    return builtin_feature(session, user_id, "news", lock=lock)


def recover_expired_manual_refresh(session, user_id, *, now=None):
    """Fence an abandoned HTTP refresh; scheduled jobs retain their own lease recovery."""
    now = now or datetime.now(UTC)
    # Every publisher takes Feature before Briefing. Keep the same order so expiry
    # cannot race between a publisher's generation check and its final write.
    feature = news_feature(session, user_id, lock=True)
    if feature is None:
        return False
    result = session.execute(
        update(NewsBriefing)
        .where(
            NewsBriefing.feature_id == feature.id,
            NewsBriefing.status == "loading",
            NewsBriefing.manual_refresh_deadline.is_not(None),
            NewsBriefing.manual_refresh_deadline <= now,
        )
        .values(
            status="failed",
            error_code="NEWS_REFRESH_INTERRUPTED",
            generation=NewsBriefing.generation + 1,
            manual_refresh_deadline=None,
        )
        .execution_options(synchronize_session=False)
    )
    return result.rowcount > 0


def news_read(session, feature, settings):
    if feature is None:
        return NewsRead(configured=bool(settings.searxng_base_url))
    row = session.get(NewsBriefing, feature.id)
    current = row is not None and row.feature_revision == feature.revision
    return NewsRead(
        feature_id=feature.id,
        revision=feature.revision,
        feature_status=feature.status,
        topic=feature.work,
        schedule=feature.schedule,
        configured=bool(settings.searxng_base_url),
        status=row.status if current else "empty",
        articles=row.articles if current else [],
        collected_at=row.collected_at if current else None,
        result_is_stale=bool(
            current
            and row.collected_at
            and (row.status in {"loading", "failed"} or (row.summary_error and row.summary_text))
        ),
        error_code=row.error_code if current else None,
        summary_text=row.summary_text if current else None,
        summary_kind=row.summary_kind if current else None,
        summary_status=(
            "failed"
            if current and row.summary_error
            else "ready"
            if current and row.summary_kind
            else "empty"
            if current and row.status == "ready" and not row.articles
            else "not_requested"
        ),
        summary_error_code=row.summary_error if current else None,
    )


def save_news_settings(session, user_id, payload):
    """Save within the caller's transaction; never commit chat progress independently."""
    lock_user(session, user_id)
    feature = news_feature(session, user_id, lock=True)
    if feature is None:
        if payload.revision != 0:
            raise ApiError(409, "REVISION_CONFLICT", "뉴스 설정을 다시 조회해 주세요.")
        return create_feature(
            session,
            user_id,
            FeatureCreate(
                builtin_key="news",
                title="뉴스 브리핑",
                work=payload.topic,
                icon="news",
                schedule=payload.schedule,
            ),
        )
    check_revision(feature, payload.revision)
    # update_feature also rebases the last briefing when the topic is unchanged.
    return update_feature(
        session,
        user_id,
        feature.id,
        FeatureUpdate(
            revision=payload.revision,
            title=feature.title,
            description=feature.description,
            work=payload.topic,
            reference=feature.reference,
            icon=feature.icon,
            schedule=payload.schedule,
            allowed_actions=feature.allowed_actions,
        ),
    )


def store_market_snapshot(watch, quote, collected_at):
    """Keep the latest provider quote while each run retains its own fetched result."""
    current = watch.snapshot
    if current and current.get("symbol") == quote.symbol:
        current_as_of = datetime.fromisoformat(current["as_of"])
        current_observed = (
            datetime.fromisoformat(current["observed_at"]) if current.get("observed_at") else None
        )
        latest = (watch.collected_at or collected_at) + MAX_MARKET_CLOCK_SKEW
        # Invalid future clocks cannot pin the snapshot. An invalid observation
        # only disables its tie-breaker; valid provider-time ordering still applies.
        if current_as_of <= latest:
            if quote.as_of < current_as_of:
                return False
            # Observation time breaks provider-time ties only when both are present.
            # Otherwise retain completion order for equal as_of.
            if (
                quote.as_of == current_as_of
                and quote.observed_at is not None
                and current_observed is not None
                and current_observed <= latest
                and quote.observed_at < current_observed
            ):
                return False
    watch.snapshot = quote.model_dump(mode="json")
    watch.collected_at = collected_at
    return True


def market_settings_read(session, user_id, settings):
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
    feature = builtin_feature(session, user_id, "stock")
    return MarketSettingsRead(
        symbol=row.symbol if row else None,
        revision=row.revision if row else 0,
        configured=market_configured(settings),
        provider="Korea Investment Open API"
        if settings.kis_enabled
        else settings.market_data_provider,
        feature_id=feature.id if feature else None,
        feature_revision=feature.revision if feature else None,
        schedule=feature.schedule if feature else None,
    )


def save_market_settings(session, user_id, payload, settings):
    if settings.kis_enabled:
        instrument(payload.symbol, settings)
    lock_user(session, user_id)
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
    if row is None:
        if payload.revision != 0:
            raise ApiError(409, "REVISION_CONFLICT", "관심 종목을 다시 조회해 주세요.")
        row = MarketWatch(user_id=user_id, symbol=payload.symbol)
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
    if "schedule" in payload.model_fields_set:
        feature = builtin_feature(session, user_id, "stock", lock=True)
        if feature is None:
            if payload.feature_revision is not None:
                raise ApiError(409, "REVISION_CONFLICT", "주가 예약을 다시 조회해 주세요.")
            if payload.schedule is not None:
                create_feature(
                    session,
                    user_id,
                    FeatureCreate(
                        builtin_key="stock",
                        title="관심 주가",
                        work="관심 종목의 시세 확인",
                        icon="chart",
                        schedule=payload.schedule,
                    ),
                )
        else:
            check_revision(feature, payload.feature_revision)
            update_feature(
                session,
                user_id,
                feature.id,
                FeatureUpdate(
                    revision=feature.revision,
                    title=feature.title,
                    description=feature.description,
                    work=feature.work or "관심 종목의 시세 확인",
                    reference=feature.reference,
                    icon=feature.icon,
                    schedule=payload.schedule,
                    allowed_actions=feature.allowed_actions,
                ),
            )
    session.flush()
    return row


def chosen_symbol(session, user_id, symbol):
    if symbol:
        return symbol.upper()
    row = session.scalar(select(MarketWatch).where(MarketWatch.user_id == user_id))
    if row is None:
        raise ApiError(422, "SYMBOL_REQUIRED", "먼저 관심 종목을 선택해 주세요.")
    return row.symbol
