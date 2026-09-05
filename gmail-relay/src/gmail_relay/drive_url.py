"""Parse a Google Drive / Docs file link (or a bare file id) into a file id.

Folder links are rejected — this tool relays one file, not a directory.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

# Drive file ids are typically ~33 chars; keep a floor high enough that a
# phrase like "not-a-link" isn't treated as a bare id.
_FILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{19,}$")

# /file/d/ID, /document/d/ID, /spreadsheets/d/ID, /presentation/d/ID, /drawings/d/ID
_PATH_ID_RE = re.compile(
    r"/(?:file|document|spreadsheets|presentation|drawings)/d/([A-Za-z0-9_-]+)"
)
_FOLDER_PATH_RE = re.compile(r"/drive/(?:u/\d+/)?folders/")


class DriveUrlError(ValueError):
    """The string is not a usable Drive file link or id."""


def parse_drive_file_id(drive_url: str) -> str:
    raw = drive_url.strip()
    if not raw:
        raise DriveUrlError("drive_url is empty")

    if _FILE_ID_RE.fullmatch(raw):
        return raw

    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if host not in {"drive.google.com", "docs.google.com"}:
        raise DriveUrlError(
            "drive_url must be a drive.google.com / docs.google.com link, or a bare file id"
        )

    if _FOLDER_PATH_RE.search(parsed.path or ""):
        raise DriveUrlError(
            "drive_url points at a Drive folder, not a file — pass a file link"
        )

    path_match = _PATH_ID_RE.search(parsed.path or "")
    if path_match:
        return path_match.group(1)

    query = parse_qs(parsed.query)
    for key in ("id", "fileId"):
        values = query.get(key) or []
        if values and _FILE_ID_RE.fullmatch(values[0]):
            return values[0]

    raise DriveUrlError("Could not find a Drive file id in drive_url")
