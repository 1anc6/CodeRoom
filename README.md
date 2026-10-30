# CodeRoom

Temporary rooms that people join with a five-digit code to chat and share files in real time.
The full product and architecture plan is in [CodeRoom_Project_Blueprint.pdf](CodeRoom_Project_Blueprint.pdf).

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 Setup | Repo, FastAPI backend, Postgres via Docker, Alembic, tests | Done |
| M1 Rooms and join | Create room, join by code, room-scoped sessions, expiry checks, rate limits | Done |
| M2 Real-time chat | WebSockets, message history, presence, reconnect | Next |
| M3 File sharing | Uploads/downloads through the API, quotas, type checks | |
| M4 Expiration | Cleanup worker that revokes access and deletes stored files | |
| M5 Harden and deploy | Abuse controls, failure testing, hosting | |
| Frontend | React + Vite + TypeScript | Not started |

## Layout

```
backend/              FastAPI app
  app/
    main.py           app factory, CORS, rate limiters
    config.py         settings (CODEROOM_* env vars)
    models.py         rooms, participants
    routers/rooms.py  room endpoints
    security.py       room codes and session tokens
    rate_limit.py     in-memory sliding-window limiter
  alembic/            database migrations
  tests/
docker-compose.yml    local PostgreSQL
```

## Running locally

Requires Python 3.12+ and Docker.

Start PostgreSQL:

```bash
docker compose up -d db
```

Set up the backend (from `backend/`):

```bash
python -m venv .venv
```

```bash
.venv/Scripts/python -m pip install -e ".[dev]"
```

On macOS/Linux use `.venv/bin/python` instead of `.venv/Scripts/python`.

Copy `backend/.env.example` to `backend/.env` and set `CODEROOM_CODE_HASH_KEY` to a random value:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Apply migrations and start the API:

```bash
.venv/Scripts/alembic upgrade head
```

```bash
.venv/Scripts/uvicorn app.main:create_app --factory --reload
```

Interactive API docs are at http://localhost:8000/docs.

## Tests

```bash
.venv/Scripts/python -m pytest
```

Tests use a temporary SQLite database by default. To run them against the Postgres container instead
(it creates a `coderoom_test` database on first start):

```bash
CODEROOM_TEST_DATABASE_URL=postgresql+asyncpg://coderoom:coderoom@localhost:5432/coderoom_test .venv/Scripts/python -m pytest
```

## API (so far)

All room endpoints except create and join need `Authorization: Bearer <token>`, using the token returned
by create or join. Tokens are never put in URLs.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/rooms` | Create a room. Body: `display_name`, optional `lifetime_minutes` (5–480, default 120). Returns the room, the creator's participant record, the code and a session token. |
| POST | `/api/rooms/join` | Join with `code` and `display_name`. Same response shape as create. |
| GET | `/api/rooms/{room_id}` | Room details and current participants. |
| DELETE | `/api/rooms/{room_id}/leave` | Leave the room. The session token stops working. |
| GET | `/api/health` | Health check. |

Status codes worth knowing: `404` unknown or expired code on join, `409` room full, `410` room expired,
`429` rate limited (with `Retry-After`).

## How access works

- Room codes come from a cryptographically secure generator and are stored only as an HMAC keyed with
  `CODEROOM_CODE_HASH_KEY`. The server cannot show a room's code again, so the client keeps it.
- A code is unique among active rooms. Once a room expires its code can be reused.
- Each join issues a random session token, stored only as a SHA-256 hash and valid for one room.
- Expiry is checked on every request, so expired rooms are closed even before the cleanup worker
  (M4) exists.
- Failed joins are limited to 5 per minute per IP, and room creation to 10 per 10 minutes per IP.
  Limits are held in memory, which suits a single app instance. Behind a proxy, run uvicorn with
  `--proxy-headers --forwarded-allow-ips=<proxy ip>` so limits apply to real client IPs.
