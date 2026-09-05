"""Thin Gmail API (REST) client — httpx only, no google-api-python-client.

Kept to plain httpx + the credentials module rather than the official Python
client library to avoid a heavier dependency for the handful of calls this
service actually needs (list, get, attachments.get, messages.modify)."""

from __future__ import annotations

import base64
from typing import Any

import httpx

from gmail_relay.credentials import GmailCredentials

GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


class GmailApiError(RuntimeError):
    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Gmail API HTTP {status_code}: {body}")
        self.status_code = status_code


class GmailClient:
    def __init__(self, credentials: GmailCredentials, http_client: httpx.AsyncClient) -> None:
        self._credentials = credentials
        self._http = http_client

    async def _headers(self) -> dict[str, str]:
        token = await self._credentials.access_token(self._http)
        return {"Authorization": f"Bearer {token}"}

    async def list_message_ids(self, query: str, max_results: int) -> list[str]:
        resp = await self._http.get(
            f"{GMAIL_API_BASE}/messages",
            params={"q": query, "maxResults": max_results},
            headers=await self._headers(),
        )
        if resp.status_code != 200:
            raise GmailApiError(resp.status_code, resp.text)
        return [m["id"] for m in resp.json().get("messages", [])]

    async def get_message_full(self, message_id: str) -> dict[str, Any]:
        # format=full (not metadata/minimal) — the lighter formats omit
        # attachmentId entirely, so this is the only format usable here.
        resp = await self._http.get(
            f"{GMAIL_API_BASE}/messages/{message_id}",
            params={"format": "full"},
            headers=await self._headers(),
        )
        if resp.status_code != 200:
            raise GmailApiError(resp.status_code, resp.text)
        return resp.json()

    async def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        resp = await self._http.get(
            f"{GMAIL_API_BASE}/messages/{message_id}/attachments/{attachment_id}",
            headers=await self._headers(),
        )
        if resp.status_code != 200:
            raise GmailApiError(resp.status_code, resp.text)
        data = resp.json()["data"]
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))

    async def mark_read(self, message_id: str) -> None:
        resp = await self._http.post(
            f"{GMAIL_API_BASE}/messages/{message_id}/modify",
            json={"removeLabelIds": ["UNREAD"]},
            headers=await self._headers(),
        )
        if resp.status_code != 200:
            raise GmailApiError(resp.status_code, resp.text)
