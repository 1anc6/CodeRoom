# CodeRoom

Temporary rooms that people join with a five-digit code to chat and share files in real time.
The full product and architecture plan is in [CodeRoom_Project_Blueprint.pdf](CodeRoom_Project_Blueprint.pdf).

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 Setup | Repo, FastAPI backend, Postgres via Docker, Alembic, tests | Done |
| M1 Rooms and join | Create room, join by code, room-scoped sessions, expiry checks, rate limits | Done |
| M2 Real-time chat | WebSockets, message history, presence, reconnect | Done |
| M3 File sharing | Uploads/downloads through the API, quotas, type checks | Done (local disk storage) |
| M4 Expiration | Cleanup worker that revokes access and deletes stored files | Next |
| M5 Harden and deploy | Abuse controls, failure testing, Cloudflare R2 storage adapter, hosting | |
| Frontend | React + Vite + TypeScript | Not started |

## Layout

```
backend/              FastAPI app
  app/
    main.py           app factory, CORS, rate limiters
    config.py         settings (CODEROOM_* env vars)
    models.py         rooms, participants, messages, files
    routers/          rooms, message history, files, WebSocket endpoint
    realtime.py       live connections per room: broadcast, presence, expiry
    messages.py       message queries shared by HTTP and WebSocket routes
    storage.py        file storage interface; local-disk implementation
    file_types.py     allowed upload types, detected from file contents
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
| GET | `/api/rooms/{room_id}` | Room details and current participants, each with an `online` flag. |
| GET | `/api/rooms/{room_id}/messages` | Message history, oldest first. See below. |
| POST | `/api/rooms/{room_id}/files?name=<file name>` | Upload a file. The body is the raw file bytes. See below. |
| GET | `/api/rooms/{room_id}/files` | The room's files (newest 200), oldest first. |
| GET | `/api/rooms/{room_id}/files/{file_id}` | Download a file. |
| DELETE | `/api/rooms/{room_id}/leave` | Leave the room. The session token stops working and open sockets close. |
| WS | `/api/rooms/{room_id}/ws` | Real-time connection. See below. |
| GET | `/api/health` | Health check. |

Status codes worth knowing: `404` unknown or expired code on join, `409` room full, `410` room expired,
`413` file too large or room out of space, `415` file type not allowed, `429` rate limited (with
`Retry-After`).

### Files

Upload by sending the file itself as the request body, not as a multipart form, with its name in the
`name` query parameter. In a browser that's `fetch(url, {method: "POST", body: file, headers})`, or
`XMLHttpRequest` if you want upload progress. The server streams the body to storage as it arrives.

- **Limits:** 25 MB per file, 100 MB per room in total, 10 uploads per minute per participant. Uploads
  that cross a limit are refused before or while streaming, and nothing partial is kept.
- **Types:** decided from the file's first bytes. The `Content-Type` the client sends is ignored.
  Allowed: JPEG, PNG, GIF, WebP, HEIC, AVIF images; PDF; Word, Excel, PowerPoint and OpenDocument
  files; `.txt`, `.md` and `.csv` text in UTF-8; MP4, MOV, WebM and MKV video. Anything else, including
  HTML, SVG, archives and programs, gets `415`.
- **Names:** folders and control characters are stripped. If the extension doesn't match the detected
  type, the right one is added, so `photo.exe` holding a PNG becomes `photo.exe.png`.
- **Storage:** each file is stored under a random key in `CODEROOM_STORAGE_DIR` (default
  `data/uploads`). Client file names never reach the storage path.
- **Live event:** a successful upload sends `file.ready` to everyone connected to the room. Its `file`
  has the same shape as the upload response: `{id, participant_id, display_name, name, mime_type,
  size_bytes, created_at}`.

Downloads need the same `Authorization` header as other endpoints, so a browser should `fetch` the
file and show it through a blob URL (for image and video previews too) rather than linking to it
directly. Responses are always `attachment`, with `X-Content-Type-Options: nosniff`, a sandboxing
`Content-Security-Policy` and `Cache-Control: private, no-store`. A file is only reachable through
its own room's URL and with a session for that room, so a file id alone grants nothing.

Files from expired rooms stay on disk until the cleanup worker (M4) exists, but they can't be
downloaded once the room has expired.

### Message history

`GET /api/rooms/{room_id}/messages?limit=50` returns `{"messages": [...], "has_more": bool}`, oldest first.

- No cursor: the latest `limit` messages (1–100, default 50). Use this on page load.
- `before=<message id>`: older messages, for scrolling back. `has_more` says whether to keep going.
- `after=<message id>`: newer messages, for catching up after a reconnect.

Each message is `{id, participant_id, display_name, content, created_at}`. Content is plain text and
must be rendered as text, never as HTML.

### WebSocket protocol

All frames are JSON objects with a `type`. Connect to `/api/rooms/{room_id}/ws`, then send the token
as the first frame within 5 seconds. Don't put it in the URL:

```json
{"type": "auth", "token": "<session token>"}
```

The server replies with `ready`, then streams events.

| Direction | Type | Fields |
|---|---|---|
| client → server | `auth` | `token` |
| client → server | `message.send` | `content` (1–4000 chars), optional `client_id` (≤ 64 chars) |
| client → server | `ping` | |
| server → client | `ready` | `me`, `participants` (each with `online`) |
| server → client | `message.new` | `message`, `client_id` (echoes the sender's, so it can match its pending message) |
| server → client | `participant.joined` | `participant` |
| server → client | `participant.left` | `participant_id` |
| server → client | `file.ready` | `file` (see Files above) |
| server → client | `presence` | `participant_id`, `online` (sent when someone's first tab opens or last tab closes) |
| server → client | `room.expired` | sent just before the server closes every socket in the room |
| server → client | `error` | `code`, `detail`, `client_id`. The connection stays open. |
| server → client | `pong` | |

Error codes: `invalid_message`, `message_too_long`, `rate_limited` (20 messages per 10 seconds),
`invalid_json`, `unsupported_frame`, `frame_too_large`, `unknown_type`.

Close codes: `1000` left the room, `1011` server couldn't deliver to this client, `4400` bad first
frame, `4401` invalid session, `4408` no auth frame in time, `4410` room expired, `4429` too many open
connections (5 per participant).

Suggested client behaviour on reconnect: reconnect with backoff unless the close code is `1000`,
`4401` or `4410`, then fetch `messages?after=<last message id you have>` to fill the gap.

Messages are stored before they are broadcast, so anything a client receives is already in history.
Connections live in process memory, which suits a single app instance. Running several instances
would need a shared pub/sub layer for broadcasts.

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
