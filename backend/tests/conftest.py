import os
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI

from app.config import Settings
from app.main import create_app
from app.models import Base

# Tests use a throwaway SQLite file by default. To run them against PostgreSQL instead, set
# CODEROOM_TEST_DATABASE_URL (e.g. postgresql+asyncpg://coderoom:coderoom@localhost:5432/coderoom_test).
TEST_DATABASE_URL = os.environ.get("CODEROOM_TEST_DATABASE_URL")

ClientFactory = Callable[[Settings], AbstractAsyncContextManager[httpx.AsyncClient]]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@asynccontextmanager
async def _running_app(settings: Settings) -> AsyncIterator[FastAPI]:
    app = create_app(settings)
    async with app.state.engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield app
    finally:
        await app.state.engine.dispose()


@asynccontextmanager
async def _client_for(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.fixture
def make_settings(tmp_path) -> Callable[..., Settings]:
    def _make(**overrides) -> Settings:
        values = {
            "database_url": TEST_DATABASE_URL or f"sqlite+aiosqlite:///{tmp_path / 'test.db'}",
            "code_hash_key": "test-code-hash-key-0123456789abcdef",
            **overrides,
        }
        return Settings(_env_file=None, **values)

    return _make


@pytest.fixture
async def app(make_settings) -> AsyncIterator[FastAPI]:
    async with _running_app(make_settings()) as app:
        yield app


@pytest.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    async with _client_for(app) as client:
        yield client


@pytest.fixture
def client_factory() -> ClientFactory:
    """For tests that need non-default settings, e.g. a lower participant cap."""

    @asynccontextmanager
    async def _factory(settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
        async with _running_app(settings) as app, _client_for(app) as client:
            yield client

    return _factory
