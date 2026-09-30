from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select

from mori.auth.models import (
    AccessToken,
    AuthSession,
    LoginGrant,
    OAuthFlow,
    RefreshToken,
    SocialIdentity,
    User,
)
from mori.auth.router import profile_router
from mori.auth.router import router as auth_router
from mori.chat.models import ChatTurn, Conversation
from mori.chat.router import router as chat_router
from mori.config import Settings
from mori.database import DatabaseSession, build_engine, build_session_factory
from mori.errors import ErrorResponse, register_error_handlers
from mori.membership.models import AccessChange
from mori.membership.router import router as membership_router
from mori.organizer import calendar, notes
from mori.organizer.models import CalendarEvent, Note, UserPreference, WriteReceipt
from mori.organizer import documents, reminders
from mori.organizer.models import Document, Reminder
from mori.features.models import Feature, FeatureResult, SkillVersion
from mori.features.router import router as features_router
from mori.parking.models import ParkingRecord
from mori.parking.router import router as parking_router


class HealthStatus(BaseModel):
    status: str


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = build_engine(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="Mori API",
        version="0.5.0",
        description="소셜 가입, 프로 권한, 주차 기록, Hermes 검색 및 실시간 채팅 작업 상태",
        lifespan=lifespan,
    )
    app.state.session_factory = build_session_factory(engine)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        expose_headers=["X-Mori-Run-ID"],
    )

    @app.middleware("http")
    async def prevent_private_caching(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/v1/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    register_error_handlers(app)
    app.include_router(parking_router)
    app.include_router(auth_router)
    app.include_router(profile_router)
    app.include_router(membership_router)
    app.include_router(chat_router)
    app.include_router(notes.router)
    app.include_router(calendar.router)
    app.include_router(documents.router)
    app.include_router(reminders.router)
    app.include_router(features_router)

    @app.get("/health/live", response_model=HealthStatus, tags=["health"])
    def live() -> HealthStatus:
        return HealthStatus(status="ok")

    @app.get(
        "/health/ready",
        response_model=HealthStatus,
        responses={503: {"model": ErrorResponse}},
        tags=["health"],
    )
    def ready(session: DatabaseSession, response: Response) -> HealthStatus:
        # Check schema availability, not just whether a database accepts connections.
        session.execute(select(User).limit(0))
        session.execute(select(AccessToken.id).limit(0))
        session.execute(select(ParkingRecord.id).limit(0))
        for model in (SocialIdentity, AuthSession, OAuthFlow, LoginGrant, RefreshToken):
            session.execute(select(model).limit(0))
        session.execute(select(AccessChange).limit(0))
        session.execute(select(Conversation.id).limit(0))
        session.execute(select(ChatTurn.id).limit(0))
        session.execute(select(CalendarEvent).limit(0))
        session.execute(select(Note).limit(0))
        session.execute(select(UserPreference).limit(0))
        session.execute(select(WriteReceipt).limit(0))
        session.execute(select(Document).limit(0))
        session.execute(select(Reminder).limit(0))
        session.execute(select(Feature).limit(0))
        session.execute(select(FeatureResult).limit(0))
        session.execute(select(SkillVersion).limit(0))
        response.headers["Cache-Control"] = "no-store"
        return HealthStatus(status="ready")

    return app
