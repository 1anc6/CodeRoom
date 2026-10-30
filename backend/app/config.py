from functools import lru_cache

from pydantic import SecretStr, field_validator
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

    # Uploaded files are kept here until the object-storage (R2) adapter is added.
    storage_dir: str = "data/uploads"
    max_file_size_bytes: int = 25 * 1024 * 1024
    max_room_storage_bytes: int = 100 * 1024 * 1024
    upload_rate_limit: int = 10
    upload_rate_window_seconds: int = 60

    # Expired-room cleanup. Runs inside the API process unless disabled, in which case schedule
    # `python -m app.cleanup` instead (e.g. as a cron job).
    cleanup_in_app: bool = True
    cleanup_interval_seconds: float = 60
    cleanup_batch_size: int = 50
    # How often to look for stray stored objects, and how old one must be before it counts as
    # stray (so uploads still in progress are left alone).
    reconcile_interval_seconds: float = 3600
    orphan_grace_seconds: int = 3600

    @field_validator("database_url")
    @classmethod
    def _use_asyncpg(cls, url: str) -> str:
        """Hosts hand out plain postgres:// URLs; the app needs the asyncpg driver named in the scheme."""
        for scheme in ("postgres://", "postgresql://"):
            if url.startswith(scheme):
                return "postgresql+asyncpg://" + url.removeprefix(scheme)
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
