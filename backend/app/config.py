from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from CODEROOM_* environment variables or backend/.env."""

    model_config = SettingsConfigDict(env_prefix="CODEROOM_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://coderoom:coderoom@localhost:5432/coderoom"
    # Server-side secret for the keyed hash of room codes. Required to run the API,
    # but optional here so tooling such as Alembic can load settings without it.
    code_hash_key: SecretStr | None = None
    cors_origins: list[str] = ["http://localhost:5173"]

    default_room_lifetime_minutes: int = 120
    max_room_lifetime_minutes: int = 480
    max_participants: int = 20

    failed_join_limit: int = 5
    failed_join_window_seconds: int = 60
    room_create_limit: int = 10
    room_create_window_seconds: int = 600

    max_message_length: int = 4000
    message_rate_limit: int = 20
    message_rate_window_seconds: int = 10
    max_connections_per_participant: int = 5
    ws_auth_timeout_seconds: float = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
