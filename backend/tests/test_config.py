import pytest

from app.config import Settings


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("postgres://u:p@db:5432/coderoom", "postgresql+asyncpg://u:p@db:5432/coderoom"),
        ("postgresql://u:p@db:5432/coderoom", "postgresql+asyncpg://u:p@db:5432/coderoom"),
        ("postgresql+asyncpg://u:p@db:5432/coderoom", "postgresql+asyncpg://u:p@db:5432/coderoom"),
        ("sqlite+aiosqlite:///test.db", "sqlite+aiosqlite:///test.db"),
    ],
)
def test_database_url_uses_asyncpg(given: str, expected: str) -> None:
    assert Settings(database_url=given).database_url == expected
