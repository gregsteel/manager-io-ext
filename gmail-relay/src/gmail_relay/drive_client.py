"""Thin Drive API (REST) client — httpx only, same credentials as Gmail.

Needed calls: files.get (metadata + alt=media / export), files.delete.
`supportsAllDrives=true` so a file in a shared drive is reachable the same
way as one in My Drive. Native Google Docs are exported (PDF or JPEG) because
Receipts only accepts image bytes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from gmail_relay.credentials import GmailCredentials

DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

# Workspace-native types have no downloadable blob; export to something
# the existing PDF/image relay path can consume.
_EXPORT_MIME: dict[str, str] = {
    "application/vnd.google-apps.document": "application/pdf",
    "application/vnd.google-apps.spreadsheet": "application/pdf",
    "application/vnd.google-apps.presentation": "application/pdf",
    "application/vnd.google-apps.drawing": "image/jpeg",
}

_META_FIELDS = "id,name,mimeType,size,trashed,shortcutDetails"


class DriveApiError(RuntimeError):
    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Drive API HTTP {status_code}: {body}")
        self.status_code = status_code


@dataclass(frozen=True)
class DriveFileDownload:
    file_id: str
    name: str
    mime_type: str
    content: bytes


class DriveClient:
    def __init__(self, credentials: GmailCredentials, http_client: httpx.AsyncClient) -> None:
        self._credentials = credentials
        self._http = http_client

    async def _headers(self) -> dict[str, str]:
        token = await self._credentials.access_token(self._http)
        return {"Authorization": f"Bearer {token}"}

    async def _get_metadata(self, file_id: str) -> dict[str, Any]:
        resp = await self._http.get(
            f"{DRIVE_API_BASE}/files/{file_id}",
            params={
                "fields": _META_FIELDS,
                "supportsAllDrives": "true",
            },
            headers=await self._headers(),
        )
        if resp.status_code != 200:
            raise DriveApiError(resp.status_code, resp.text)
        return resp.json()

    async def resolve_file(self, file_id: str) -> dict[str, Any]:
        """Metadata for a real file, following one shortcut hop.

        Rejects folders, trashed files, and unresolved shortcuts.
        """
        meta = await self._get_metadata(file_id)
        if meta.get("mimeType") == SHORTCUT_MIME:
            target = (meta.get("shortcutDetails") or {}).get("targetId")
            if not target:
                raise DriveApiError(400, "shortcut has no targetId")
            meta = await self._get_metadata(target)
            if meta.get("mimeType") == SHORTCUT_MIME:
                raise DriveApiError(400, "shortcut target is another shortcut")
        if meta.get("trashed"):
            raise DriveApiError(410, f"file {meta.get('id')} is in trash")
        if meta.get("mimeType") == FOLDER_MIME:
            raise DriveApiError(400, "drive_url points at a folder, not a file")
        return meta

    async def download(self, file_id: str) -> DriveFileDownload:
        meta = await self.resolve_file(file_id)
        resolved_id = str(meta["id"])
        name = str(meta.get("name") or resolved_id)
        source_mime = str(meta.get("mimeType") or "application/octet-stream")
        export_mime = _EXPORT_MIME.get(source_mime)

        if export_mime:
            resp = await self._http.get(
                f"{DRIVE_API_BASE}/files/{resolved_id}/export",
                params={"mimeType": export_mime, "supportsAllDrives": "true"},
                headers=await self._headers(),
            )
            mime_type = export_mime
        else:
            resp = await self._http.get(
                f"{DRIVE_API_BASE}/files/{resolved_id}",
                params={"alt": "media", "supportsAllDrives": "true"},
                headers=await self._headers(),
            )
            mime_type = source_mime

        if resp.status_code != 200:
            raise DriveApiError(resp.status_code, resp.text)
        return DriveFileDownload(
            file_id=resolved_id,
            name=name,
            mime_type=mime_type,
            content=resp.content,
        )

    async def delete_file(self, file_id: str) -> None:
        resp = await self._http.delete(
            f"{DRIVE_API_BASE}/files/{file_id}",
            params={"supportsAllDrives": "true"},
            headers=await self._headers(),
        )
        # 204 is the documented success; 404 means it's already gone.
        if resp.status_code not in {204, 404}:
            raise DriveApiError(resp.status_code, resp.text)
