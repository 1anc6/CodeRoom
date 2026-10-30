import pytest

from app.file_types import (
    clean_filename,
    content_disposition,
    detect,
    with_matching_extension,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
ZIP = b"PK\x03\x04" + b"\x00" * 32
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 32


def ftyp(brand: bytes) -> bytes:
    return b"\x00\x00\x00\x18ftyp" + brand + b"\x00" * 16


@pytest.mark.parametrize(
    ("head", "filename", "mime"),
    [
        (b"\xff\xd8\xff\xe0" + b"\x00" * 16, "a.jpg", "image/jpeg"),
        (PNG, "a.png", "image/png"),
        (b"GIF89a" + b"\x00" * 16, "a.gif", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "a.webp", "image/webp"),
        (ftyp(b"heic"), "IMG_0001.HEIC", "image/heic"),
        (ftyp(b"avif"), "a.avif", "image/avif"),
        (b"%PDF-1.7\n", "notes.pdf", "application/pdf"),
        (ftyp(b"isom"), "lecture.mp4", "video/mp4"),
        (ftyp(b"qt  "), "clip.mov", "video/quicktime"),
        (b"\x1a\x45\xdf\xa3" + b"\x00" * 16, "a.webm", "video/webm"),
        (b"\x1a\x45\xdf\xa3" + b"\x00" * 16, "a.mkv", "video/x-matroska"),
        (ZIP, "essay.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        (ZIP, "Budget.XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        (ZIP, "slides.odp", "application/vnd.oasis.opendocument.presentation"),
        (OLE, "old.doc", "application/msword"),
        ("Hello, wörld\n".encode(), "notes.txt", "text/plain"),
        (b"a,b\n1,2\n", "data.csv", "text/csv"),
        (b"# Title\n", "README.md", "text/markdown"),
    ],
)
def test_allowed_types_are_detected_from_content(head, filename, mime):
    detected = detect(head, filename)
    assert detected is not None and detected.mime == mime


@pytest.mark.parametrize(
    ("head", "filename"),
    [
        (b"MZ\x90\x00" + b"\x00" * 32, "setup.exe"),  # Windows program
        (b"\x7fELF" + b"\x00" * 32, "tool"),  # Linux program
        (b"<!doctype html><script>alert(1)</script>", "page.html"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>", "image.svg"),
        (b"<html></html>", "trick.txt.html"),
        (ZIP, "archive.zip"),  # plain archives aren't documents
        (ZIP, "app.apk"),
        (OLE, "mystery.msi"),
        (ftyp(b"M4A "), "song.m4a"),  # audio only
        (b"plain text but no text extension", "notes"),
        (b"text\x00with a null byte", "notes.txt"),
        (b"\xff\xfe\x00latin-1 or binary", "notes.txt"),
        (b"", "empty.txt"),
    ],
)
def test_other_content_is_rejected(head, filename):
    assert detect(head, filename) is None


def test_text_sample_may_end_mid_character():
    sample = ("é" * 10).encode()[:-1]  # cut through the last two-byte character
    assert detect(sample, "notes.txt") is not None


def test_png_named_as_pdf_is_still_a_png():
    assert detect(PNG, "notes.pdf").mime == "image/png"


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("photo.jpg", "photo.jpg"),
        ("../../etc/passwd.txt", "passwd.txt"),
        ("C:\\Users\\me\\Desktop\\essay.docx", "essay.docx"),
        ("bad\x00na\u200bme\n.pdf", "badname.pdf"),
        ("  .hidden  ", "hidden"),
        ("trailing dots...", "trailing dots"),
        ("...", "file"),
        ("", "file"),
        ("学习笔记.pdf", "学习笔记.pdf"),
    ],
)
def test_clean_filename(raw, cleaned):
    assert clean_filename(raw) == cleaned


def test_long_names_are_shortened_but_keep_their_extension():
    cleaned = clean_filename("a" * 300 + ".pdf")
    assert len(cleaned) == 200
    assert cleaned.endswith(".pdf")


def test_extension_is_added_when_missing_or_wrong():
    png = detect(PNG, "x")
    assert with_matching_extension("photo.PNG", png) == "photo.PNG"
    assert with_matching_extension("photo", png) == "photo.png"
    assert with_matching_extension("photo.exe", png) == "photo.exe.png"


def test_content_disposition_keeps_unicode_and_escapes_quotes():
    header = content_disposition('学习 "notes".pdf')
    assert header.startswith('attachment; filename="')
    assert 'filename="__ _notes_.pdf"' in header
    assert "filename*=UTF-8''%E5%AD%A6%E4%B9%A0%20%22notes%22.pdf" in header
