from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select

from mori.auth.models import AccessToken, User
from mori.config import Settings
from mori.database import DatabaseSession, build_engine, build_session_factory
from mori.errors import ErrorResponse, register_error_handlers
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
        version="0.1.0",
        description="개인 알파: 인증된 사용자의 주차 기록 저장·조회",
        lifespan=lifespan,
    )
    app.state.session_factory = build_session_factory(engine)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )

    @app.middleware("http")
    async def prevent_private_caching(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/v1/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    register_error_handlers(app)
    app.include_router(parking_router)

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
        session.execute(select(User.id).limit(0))
        session.execute(select(AccessToken.id).limit(0))
        session.execute(select(ParkingRecord.id).limit(0))
        response.headers["Cache-Control"] = "no-store"
        return HealthStatus(status="ready")

    return app
