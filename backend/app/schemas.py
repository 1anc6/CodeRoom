import unicodedata
import uuid
from datetime import datetime
from typing import Annotated

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
# [0-9] rather than \d, which would also accept non-ASCII digits.
RoomCode = Annotated[str, StringConstraints(pattern=r"^[0-9]{5}$")]


class CreateRoomRequest(BaseModel):
    display_name: DisplayName
    lifetime_minutes: int | None = Field(default=None, ge=5)


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


class MessageOut(BaseModel):
    id: uuid.UUID
    participant_id: uuid.UUID
    display_name: str
    content: str
    created_at: datetime


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
