"""Room codes and participant session tokens.

A room code is a convenient locator, not strong authentication (see the blueprint).
Codes are stored only as a keyed hash, and each successful join gets its own random
session token, which is stored only as a hash and scoped to one room.
"""

import hashlib
import hmac
import secrets

ROOM_CODE_LENGTH = 5


def generate_room_code() -> str:
    return f"{secrets.randbelow(10**ROOM_CODE_LENGTH):0{ROOM_CODE_LENGTH}d}"


def hash_room_code(code: str, key: str) -> str:
    return hmac.new(key.encode(), code.encode(), hashlib.sha256).hexdigest()


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    # Tokens carry 256 bits of randomness, so a plain hash is enough; no key or salt needed.
    return hashlib.sha256(token.encode()).hexdigest()
