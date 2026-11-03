from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select

from mori.account.router import router as account_router
from mori.artifacts.router import router as artifacts_router
from mori.auth.router import profile_router
from mori.auth.router import router as auth_router
from mori.automation.router import router as automation_router
from mori.billing.router import router as billing_router
from mori.chat.router import router as chat_router
from mori.config import Settings
from mori.dashboard.router import router as dashboard_router
from mori.database import Base, DatabaseSession, build_engine, build_session_factory
from mori.documentation import DESCRIPTION, TAGS, install_scalar
from mori.errors import ErrorResponse, register_error_handlers
from mori.features.router import router as features_router
from mori.integrations.router import router as integrations_router
from mori.membership.router import router as membership_router
from mori.notifications.router import router as notifications_router
from mori.operations.router import router as capabilities_router
from mori.operations.speech import router as speech_router
from mori.organizer import calendar, documents, notes, reminders
from mori.parking.router import router as parking_router
from mori.runtimes.router import router as runtimes_router


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
        version="0.9.0",
        description=DESCRIPTION,
        openapi_tags=TAGS,
        swagger_ui_parameters={
            "filter": True,
            "docExpansion": "none",
            "defaultModelsExpandDepth": -1,
            "persistAuthorization": False,
        },
        lifespan=lifespan,
    )
    install_scalar(app)
    app.state.session_factory = build_session_factory(engine)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "Last-Event-ID"],
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
    for router in (
        capabilities_router,
        speech_router,
        artifacts_router,
        runtimes_router,
        billing_router,
        notes.router,
        calendar.router,
        reminders.router,
        documents.router,
        account_router,
        features_router,
        dashboard_router,
        automation_router,
        integrations_router,
        notifications_router,
    ):
        app.include_router(router)

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
        # All imported models participate, including optional worker/runtime schemas.
        for table in Base.metadata.sorted_tables:
            session.execute(select(table).limit(0))
        response.headers["Cache-Control"] = "no-store"
        return HealthStatus(status="ready")

    return app
