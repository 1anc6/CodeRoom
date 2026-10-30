import unicodedata
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints


def _reject_control_characters(value: str) -> str:
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("must not contain control or formatting characters")
    return value


DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=32),
    AfterValidator(_reject_control_characters),
]
# Generated codes are five digits. A host can choose their own: 4 to 12 letters or digits.
# Codes ignore case, so they are upper-cased here and stored and compared that way.
# [A-Za-z0-9] rather than \w, which would also accept non-ASCII letters and digits.
RoomCode = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9]{4,12}$"),
    AfterValidator(str.upper),
]


class CreateRoomRequest(BaseModel):
    display_name: DisplayName
    lifetime_minutes: int | None = Field(default=None, ge=5)
    code: RoomCode | None = None


class JoinRoomRequest(BaseModel):
    code: RoomCode
    display_name: DisplayName


class RoomOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    created_at: datetime
    expires_at: datetime


class ParticipantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    display_name: str
    joined_at: datetime


class RoomSessionOut(BaseModel):
    """Returned on create and join. The server keeps only a hash of the code and token,
    so the client must hold on to both (sessionStorage) to show the code and stay signed in."""

    room: RoomOut
    participant: ParticipantOut
    code: str
    token: str


class MemberOut(ParticipantOut):
    """A current room member, with whether they have a live connection right now."""

    online: bool


class RoomDetailsOut(BaseModel):
    room: RoomOut
    me: ParticipantOut
    participants: list[MemberOut]


class ReplyOut(BaseModel):
    """What a reply quotes, with enough to draw the quote even when the original isn't loaded."""

    kind: Literal["message", "file"]
    id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    # The start of the quoted message, or the quoted file's name.
    text: str
    mime_type: str | None = None


class MessageOut(BaseModel):
    id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    content: str
    created_at: datetime
    reply_to: ReplyOut | None = None


class MessagePageOut(BaseModel):
    messages: list[MessageOut]
    # Whether more messages exist beyond this page in the direction requested.
    has_more: bool


class FileOut(BaseModel):
    id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    name: str
    mime_type: str
    size_bytes: int
    created_at: datetime


class FileListOut(BaseModel):
    files: list[FileOut]
    # True if the room has more files than this list returns (only the newest are listed).
    has_more: bool
