from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from sqlalchemy import select

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import PRIVATE_API_RESPONSES, ApiError
from mori.features import service
from mori.features.models import Feature, FeatureResult, SkillVersion
from mori.features.schemas import (
    CatalogRead,
    FeatureCreate,
    FeatureRead,
    FeatureResultRead,
    FeatureState,
    FeatureUpdate,
)
from mori.organizer.service import check_revision, idempotent_create, owned

router = APIRouter(responses=PRIVATE_API_RESPONSES, prefix="/v1", tags=["features"])


@router.get("/feature-catalog", response_model=CatalogRead)
def catalog(user: CurrentUser):
    return {
        "items": service.CATALOG,
        "template_version": 1,
        "capabilities": {
            "scheduled_execution": False,
            "push_delivery": False,
            "market_data": False,
            "office_conversion": False,
            "text_document_storage": True,
            "custom_chat_execution": True,
        },
    }


@router.post("/features", response_model=FeatureRead, status_code=201)
def create(
    payload: FeatureCreate,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
):
    return idempotent_create(
        session,
        user.id,
        "features",
        idempotency_key,
        payload,
        lambda: service.create_feature(session, user.id, payload),
        service.read_feature,
    )


@router.get("/features", response_model=list[FeatureRead])
def listing(
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    return [
        service.read_feature(row)
        for row in session.scalars(
            select(Feature)
            .where(
                Feature.user_id == user.id,
                Feature.deleted_at.is_(None),
            )
            .order_by(Feature.updated_at.desc(), Feature.id.desc())
            .offset(offset)
            .limit(limit)
        )
    ]


@router.get("/features/{feature_id}", response_model=FeatureRead)
def detail(feature_id: UUID, user: CurrentUser, session: DatabaseSession):
    return service.read_feature(owned(session, Feature, user.id, feature_id))


@router.put("/features/{feature_id}", response_model=FeatureRead)
def replace(feature_id: UUID, payload: FeatureUpdate, user: CurrentUser, session: DatabaseSession):
    row = service.update_feature(session, user.id, feature_id, payload)
    session.commit()
    return service.read_feature(row)


@router.post("/features/{feature_id}/state", response_model=FeatureRead)
def state(feature_id: UUID, payload: FeatureState, user: CurrentUser, session: DatabaseSession):
    row = owned(session, Feature, user.id, feature_id, lock=True)
    check_revision(row, payload.revision)
    if payload.status == "active" and not row.work:
        raise ApiError(409, "FEATURE_INCOMPLETE", "수행할 내용을 먼저 입력해 주세요.")
    if row.status != payload.status:
        row.status = payload.status
        row.revision += 1
        row.updated_at = datetime.now(UTC)
    session.commit()
    return service.read_feature(row)


@router.get("/features/{feature_id}/versions/{version}", response_model=FeatureRead)
def version(feature_id: UUID, version: int, user: CurrentUser, session: DatabaseSession):
    owned(session, Feature, user.id, feature_id)
    row = session.get(SkillVersion, (feature_id, version))
    if row is None:
        raise ApiError(404, "VERSION_NOT_FOUND", "기능 버전을 찾을 수 없습니다.")
    return row.definition


@router.get("/features/{feature_id}/results", response_model=list[FeatureResultRead])
def results(
    feature_id: UUID,
    user: CurrentUser,
    session: DatabaseSession,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100000),
):
    owned(session, Feature, user.id, feature_id)
    return list(
        session.scalars(
            select(FeatureResult)
            .where(
                FeatureResult.user_id == user.id,
                FeatureResult.feature_id == feature_id,
                FeatureResult.deleted_at.is_(None),
            )
            .order_by(FeatureResult.created_at.desc(), FeatureResult.id.desc())
            .offset(offset)
            .limit(limit)
        )
    )


@router.get("/feature-results/{result_id}", response_model=FeatureResultRead)
def result(result_id: UUID, user: CurrentUser, session: DatabaseSession):
    return owned(session, FeatureResult, user.id, result_id)
