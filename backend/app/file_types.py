"""Allowed upload types, detected from file contents rather than trusted from the client.

Only images, PDFs, common documents, plain text and videos are accepted (see the blueprint).
Anything a browser could run as a page or script (HTML, SVG, JavaScript) or that the OS could
run as a program is rejected because it matches no signature here.
"""

import codecs
import os
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote

# How many leading bytes to read before deciding a file's type.
SNIFF_BYTES = 4096

_MAX_NAME_LENGTH = 200
_MAX_EXTENSION_LENGTH = 16


@dataclass(frozen=True)
class FileType:
    mime: str
    extensions: tuple[str, ...]  # the first one is added when a name lacks a matching extension

    @property
    def is_text(self) -> bool:
        return self.mime.startswith("text/")


JPEG = FileType("image/jpeg", (".jpg", ".jpeg"))
PNG = FileType("image/png", (".png",))
GIF = FileType("image/gif", (".gif",))
WEBP = FileType("image/webp", (".webp",))
HEIC = FileType("image/heic", (".heic", ".heif"))
AVIF = FileType("image/avif", (".avif",))
PDF = FileType("application/pdf", (".pdf",))
MP4 = FileType("video/mp4", (".mp4", ".m4v"))
QUICKTIME = FileType("video/quicktime", (".mov",))
WEBM = FileType("video/webm", (".webm",))
MATROSKA = FileType("video/x-matroska", (".mkv",))

# Office formats can't be told apart by their first bytes (they are ZIP or OLE containers),
# so the extension picks the type once the container signature has matched.
_ZIP_DOCUMENTS = {
    ".docx": FileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", (".docx",)),
    ".xlsx": FileType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", (".xlsx",)),
    ".pptx": FileType("application/vnd.openxmlformats-officedocument.presentationml.presentation", (".pptx",)),
    ".odt": FileType("application/vnd.oasis.opendocument.text", (".odt",)),
    ".ods": FileType("application/vnd.oasis.opendocument.spreadsheet", (".ods",)),
    ".odp": FileType("application/vnd.oasis.opendocument.presentation", (".odp",)),
}
_OLE_DOCUMENTS = {
    ".doc": FileType("application/msword", (".doc",)),
    ".xls": FileType("application/vnd.ms-excel", (".xls",)),
    ".ppt": FileType("application/vnd.ms-powerpoint", (".ppt",)),
}
_TEXT_DOCUMENTS = {
    ".txt": FileType("text/plain", (".txt",)),
    ".md": FileType("text/markdown", (".md",)),
    ".csv": FileType("text/csv", (".csv",)),
}

_HEIC_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"}
# ISO media brands that are audio-only or images rather than video.
_NON_VIDEO_BRANDS = {b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B "}


def extension_of(filename: str) -> str:
    return os.path.splitext(filename)[1].lower()


def detect(head: bytes, filename: str) -> FileType | None:
    """The type of a file starting with `head`, or None if it isn't an allowed type."""
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if head.startswith((b"GIF87a", b"GIF89a")):
        return GIF
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    if head.startswith(b"%PDF-"):
        return PDF
    if head[4:8] == b"ftyp":
        return _detect_iso_media(head[8:12])
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return MATROSKA if extension_of(filename) == ".mkv" else WEBM
    if head.startswith(b"PK\x03\x04"):
        return _ZIP_DOCUMENTS.get(extension_of(filename))
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return _OLE_DOCUMENTS.get(extension_of(filename))
    text_type = _TEXT_DOCUMENTS.get(extension_of(filename))
    if text_type is not None and _looks_like_text(head):
        return text_type
    return None


def _detect_iso_media(brand: bytes) -> FileType | None:
    if brand in _HEIC_BRANDS:
        return HEIC
    if brand in (b"avif", b"avis"):
        return AVIF
    if brand == b"qt  ":
        return QUICKTIME
    if brand in _NON_VIDEO_BRANDS:
        return None
    return MP4


def _looks_like_text(head: bytes) -> bool:
    if not head or b"\x00" in head:
        return False
    try:
        # Not final: the sample may end partway through a multi-byte character.
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
    except UnicodeDecodeError:
        return False
    return True


def clean_filename(raw: str) -> str:
    """A display-safe name: no directories, control characters or leading/trailing dots."""
    name = re.split(r"[\\/]", raw)[-1]
    name = "".join(char for char in name if not unicodedata.category(char).startswith("C"))
    name = name.strip().strip(".").strip()
    if not name:
        return "file"
    if len(name) > _MAX_NAME_LENGTH:
        stem, extension = os.path.splitext(name)
        extension = extension[:_MAX_EXTENSION_LENGTH]
        name = stem[: _MAX_NAME_LENGTH - len(extension)] + extension
    return name


def with_matching_extension(filename: str, file_type: FileType) -> str:
    """Append the type's extension when the name doesn't already have one that fits,
    so a downloaded file opens with the right program (photo.exe becomes photo.exe.png)."""
    if extension_of(filename) in file_type.extensions:
        return filename
    return filename + file_type.extensions[0]


def content_disposition(filename: str) -> str:
    """An attachment header with an ASCII fallback and the full UTF-8 name (RFC 6266)."""
    fallback = "".join(char if 32 <= ord(char) < 127 and char not in '"\\' else "_" for char in filename)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"
