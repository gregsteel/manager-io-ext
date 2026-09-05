"""Extracts search-result metadata and attachment listings from a Gmail API
`messages.get(format=full)` body. Gmail's lighter formats (metadata/minimal)
omit attachmentIds entirely, so search_gmail always fetches full — see
gmail_client.py."""

from __future__ import annotations

from typing import Any


def _header(payload: dict[str, Any], name: str) -> str | None:
    for h in payload.get("headers", []) or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value")
    return None


def _walk_parts(part: dict[str, Any]) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    filename = part.get("filename")
    body = part.get("body") or {}
    if filename and body.get("attachmentId"):
        attachments.append(
            {
                "attachmentId": body["attachmentId"],
                "filename": filename,
                "mimeType": part.get("mimeType"),
                "size": body.get("size"),
            }
        )
    for sub in part.get("parts") or []:
        attachments.extend(_walk_parts(sub))
    return attachments


def summarize_message(message: dict[str, Any]) -> dict[str, Any]:
    payload = message.get("payload") or {}
    return {
        "id": message["id"],
        "threadId": message.get("threadId"),
        "subject": _header(payload, "Subject"),
        "from": _header(payload, "From"),
        "date": _header(payload, "Date"),
        "labelIds": message.get("labelIds", []),
        "attachments": _walk_parts(payload),
    }


def find_attachment_mime_type(message: dict[str, Any], attachment_id: str) -> str | None:
    payload = message.get("payload") or {}
    for attachment in _walk_parts(payload):
        if attachment["attachmentId"] == attachment_id:
            return attachment.get("mimeType")
    return None
