"""FastMCP gmail-relay server.

Exposes Gmail search + attachment/Drive-relay-to-Receipts as MCP tools for
Cowork, gated by the same Google-OAuth + email-allowlist pattern as
manager-mcp (see http_auth.py) since this is reachable from the open
internet. Attachment bytes flow disk -> HTTP body -> Receipts directly;
they are never returned to a tool caller."""

from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path
from typing import Any

import httpx
from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response

from gmail_relay.credentials import GmailCredentials, GmailCredentialsError
from gmail_relay.download_dir import JailedTempFile
from gmail_relay.drive_client import DriveApiError, DriveClient
from gmail_relay.drive_url import DriveUrlError, parse_drive_file_id
from gmail_relay.gmail_client import GmailApiError, GmailClient
from gmail_relay.http_auth import build_run_kwargs
from gmail_relay.message_parsing import find_attachment_mime_type, summarize_message
from gmail_relay.relay_upload import RelayUploadError, convert_and_upload

CREDENTIALS_PATH_ENV = "GMAIL_CREDENTIALS_PATH"
DOWNLOAD_DIR_ENV = "RELAY_DOWNLOAD_DIR"
MAX_ATTACHMENT_BYTES_ENV = "RELAY_MAX_ATTACHMENT_BYTES"
DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
DEFAULT_DOWNLOAD_DIR = "/data/tmp"

logger = logging.getLogger("gmail_relay")

mcp = FastMCP("gmail-relay")

_credentials: GmailCredentials | None = None
_http_client: httpx.AsyncClient | None = None


def get_credentials() -> GmailCredentials:
    global _credentials
    if _credentials is None:
        _credentials = GmailCredentials(Path(os.environ[CREDENTIALS_PATH_ENV]))
    return _credentials


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30.0)
    return _http_client


def get_gmail_client() -> GmailClient:
    return GmailClient(get_credentials(), get_http_client())


def get_drive_client() -> DriveClient:
    return DriveClient(get_credentials(), get_http_client())


def get_download_dir() -> Path:
    return Path(os.environ.get(DOWNLOAD_DIR_ENV, DEFAULT_DOWNLOAD_DIR))


def get_max_attachment_bytes() -> int:
    return int(os.environ.get(MAX_ATTACHMENT_BYTES_ENV, DEFAULT_MAX_ATTACHMENT_BYTES))


def reset_state() -> None:
    """Test helper: drop cached credentials/http client."""
    global _credentials, _http_client
    _credentials = None
    _http_client = None


@mcp.custom_route("/health", methods=["GET"], include_in_schema=False)
async def health(_request: Request) -> Response:
    try:
        await get_credentials().access_token(get_http_client())
    except GmailCredentialsError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=503)
    return PlainTextResponse("ok")


@mcp.tool(
    description=(
        "Search Gmail (read-only, metadata only — safe to return through an LLM's "
        "context, no attachment bytes). `q` uses Gmail search syntax, e.g. "
        "'label:lilith is:unread'. Each message's attachments[] lists attachmentId/"
        "filename/mimeType/size; pass attachmentId (and that mimeType) to "
        "relay_attachment to fetch bytes."
    )
)
async def search_gmail(q: str, max_results: int = 25) -> dict[str, Any]:
    client = get_gmail_client()
    try:
        ids = await client.list_message_ids(q, max_results)
        messages = [summarize_message(await client.get_message_full(mid)) for mid in ids]
    except GmailApiError as exc:
        raise RuntimeError(str(exc)) from exc
    return {"messages": messages}


@mcp.tool(
    description=(
        "Download one Gmail attachment and relay it to a Receipts create_receipt "
        "uploadUrl — bytes flow disk-to-disk; they are never returned by this tool. "
        "A application/pdf source has its first page converted to JPEG (Receipts' "
        "upload route rejects PDFs outright). Marks the source message read "
        "(removes the UNREAD label) only after a successful upload — a failed "
        "upload leaves it unread so it's retried. Mint uploadUrl/uploadToken via "
        "create_receipt right before calling this; the token expires in 30 minutes."
    )
)
async def relay_attachment(
    message_id: str,
    attachment_id: str,
    upload_url: str,
    upload_token: str,
    filename: str | None = None,
    mime_type: str | None = None,
) -> dict[str, Any]:
    gmail = get_gmail_client()
    jail = JailedTempFile(get_download_dir())

    def _fail(error: str) -> dict[str, Any]:
        logger.info("relay message_id=%s outcome=failed error=%s", message_id, error)
        return {"ok": False, "error": error}

    try:
        try:
            raw = await gmail.get_attachment(message_id, attachment_id)
        except GmailApiError as exc:
            return _fail(f"Gmail attachment fetch failed: {exc}")

        source_mime_type = mime_type
        if source_mime_type is None:
            try:
                message = await gmail.get_message_full(message_id)
                source_mime_type = find_attachment_mime_type(message, attachment_id)
            except GmailApiError:
                source_mime_type = None
        if source_mime_type is None:
            source_mime_type = mimetypes.guess_type(filename or "")[0]

        try:
            uploaded = await convert_and_upload(
                get_http_client(),
                raw=raw,
                source_mime_type=source_mime_type,
                filename=filename,
                upload_url=upload_url,
                upload_token=upload_token,
                jail=jail,
                max_bytes=get_max_attachment_bytes(),
            )
        except RelayUploadError as exc:
            return _fail(str(exc))

        result: dict[str, Any] = {
            "ok": True,
            "bytesUploaded": uploaded.bytes_uploaded,
            "convertedFromPdf": uploaded.converted_from_pdf,
            "contentType": uploaded.content_type,
        }
        try:
            await gmail.mark_read(message_id)
        except GmailApiError as exc:
            result["warning"] = f"Uploaded, but marking the message read failed: {exc}"
        logger.info(
            "relay message_id=%s outcome=ok bytes=%d converted_from_pdf=%s",
            message_id,
            result["bytesUploaded"],
            uploaded.converted_from_pdf,
        )
        return result
    finally:
        jail.cleanup()


@mcp.tool(
    description=(
        "Download one Google Drive file and relay it to a Receipts create_receipt "
        "uploadUrl — bytes never leave this server. `drive_url` is a Drive/Docs "
        "file link or a bare file id (folder links are rejected). A PDF source "
        "(or a Google Doc/Sheet/Slide exported as PDF) has its first page "
        "converted to JPEG. After a successful upload the Drive file is deleted "
        "when the token allows it; a 403/permission miss is reported as a "
        "warning, not a failed relay. Mint uploadUrl/uploadToken via "
        "create_receipt right before calling this; the token expires in 30 minutes."
    )
)
async def relay_drive_file(
    drive_url: str,
    upload_url: str,
    upload_token: str,
    filename: str | None = None,
    mime_type: str | None = None,
) -> dict[str, Any]:
    jail = JailedTempFile(get_download_dir())

    def _fail(error: str) -> dict[str, Any]:
        logger.info("relay_drive outcome=failed error=%s", error)
        return {"ok": False, "error": error}

    try:
        try:
            file_id = parse_drive_file_id(drive_url)
        except DriveUrlError as exc:
            return _fail(str(exc))

        drive = get_drive_client()
        try:
            downloaded = await drive.download(file_id)
        except DriveApiError as exc:
            return _fail(f"Drive download failed: {exc}")

        source_mime = mime_type or downloaded.mime_type
        source_name = filename or downloaded.name

        try:
            uploaded = await convert_and_upload(
                get_http_client(),
                raw=downloaded.content,
                source_mime_type=source_mime,
                filename=source_name,
                upload_url=upload_url,
                upload_token=upload_token,
                jail=jail,
                max_bytes=get_max_attachment_bytes(),
            )
        except RelayUploadError as exc:
            return _fail(str(exc))

        result: dict[str, Any] = {
            "ok": True,
            "bytesUploaded": uploaded.bytes_uploaded,
            "convertedFromPdf": uploaded.converted_from_pdf,
            "contentType": uploaded.content_type,
            "driveFileId": downloaded.file_id,
            "filename": downloaded.name,
            "driveFileDeleted": False,
        }
        try:
            await drive.delete_file(downloaded.file_id)
            result["driveFileDeleted"] = True
        except DriveApiError as exc:
            result["warning"] = f"Uploaded, but deleting the Drive file failed: {exc}"
        logger.info(
            "relay_drive file_id=%s outcome=ok bytes=%d deleted=%s",
            downloaded.file_id,
            result["bytesUploaded"],
            result["driveFileDeleted"],
        )
        return result
    finally:
        jail.cleanup()


def _wipe_download_dir() -> None:
    download_dir = get_download_dir()
    download_dir.mkdir(parents=True, exist_ok=True)
    for path in download_dir.iterdir():
        path.unlink(missing_ok=True)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    _wipe_download_dir()
    run_kwargs = build_run_kwargs()
    mcp.auth = run_kwargs.pop("auth", None)
    mcp.run(**run_kwargs)


if __name__ == "__main__":
    main()
