from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.db import create_engine, create_sessionmaker
from app.rate_limit import SlidingWindowLimiter
from app.realtime import RoomHub
from app.routers import files, messages, rooms, ws
from app.storage import LocalFileStorage

_MIN_CODE_HASH_KEY_LENGTH = 32


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory. Run with: uvicorn app.main:create_app --factory"""
    settings = settings or get_settings()
    key = settings.code_hash_key
    if key is None or len(key.get_secret_value()) < _MIN_CODE_HASH_KEY_LENGTH:
        raise RuntimeError(
            f"CODEROOM_CODE_HASH_KEY must be set to a random secret of at least "
            f"{_MIN_CODE_HASH_KEY_LENGTH} characters (see backend/.env.example)."
        )

    engine = create_engine(settings.database_url)
    hub = RoomHub()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        await hub.shutdown()
        await engine.dispose()

    app = FastAPI(title="CodeRoom API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessionmaker = create_sessionmaker(engine)
    app.state.hub = hub
    app.state.join_failures = SlidingWindowLimiter(settings.failed_join_limit, settings.failed_join_window_seconds)
    app.state.room_creations = SlidingWindowLimiter(settings.room_create_limit, settings.room_create_window_seconds)
    app.state.message_rate = SlidingWindowLimiter(settings.message_rate_limit, settings.message_rate_window_seconds)
    app.state.uploads = SlidingWindowLimiter(settings.upload_rate_limit, settings.upload_rate_window_seconds)
    app.state.storage = LocalFileStorage(settings.storage_dir)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(rooms.router)
    app.include_router(messages.router)
    app.include_router(files.router)
    app.include_router(ws.router)

    @app.get("/api/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
