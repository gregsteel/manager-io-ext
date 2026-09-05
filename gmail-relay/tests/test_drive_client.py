import json

import httpx
import pytest

from gmail_relay.credentials import GmailCredentials
from gmail_relay.drive_client import DriveApiError, DriveClient

FILE_ID = "1fileIdxxxxxxxxxxxx"
TARGET_ID = "1targetIdxxxxxxxxxxx"


def _creds(tmp_path):
    path = tmp_path / "credentials.json"
    path.write_text(
        json.dumps(
            {
                "client_id": "client-id",
                "client_secret": "client-secret",
                "refresh_token": "refresh-token",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
    )
    return GmailCredentials(path)


def _token_ok(request: httpx.Request) -> httpx.Response | None:
    if request.url.host == "oauth2.googleapis.com":
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
    return None


@pytest.mark.asyncio
async def test_download_binary_file(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        if request.url.params.get("alt") == "media":
            return httpx.Response(200, content=b"jpeg-bytes")
        return httpx.Response(
            200,
            json={
                "id": FILE_ID,
                "name": "scan.jpg",
                "mimeType": "image/jpeg",
                "size": "10",
                "trashed": False,
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        downloaded = await DriveClient(_creds(tmp_path), client).download(FILE_ID)

    assert downloaded.file_id == FILE_ID
    assert downloaded.name == "scan.jpg"
    assert downloaded.mime_type == "image/jpeg"
    assert downloaded.content == b"jpeg-bytes"


@pytest.mark.asyncio
async def test_download_exports_google_doc_as_pdf(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        if "/export" in str(request.url):
            assert request.url.params["mimeType"] == "application/pdf"
            return httpx.Response(200, content=b"%PDF-1.4")
        return httpx.Response(
            200,
            json={
                "id": FILE_ID,
                "name": "Invoice",
                "mimeType": "application/vnd.google-apps.document",
                "trashed": False,
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        downloaded = await DriveClient(_creds(tmp_path), client).download(FILE_ID)

    assert downloaded.mime_type == "application/pdf"
    assert downloaded.content.startswith(b"%PDF")


@pytest.mark.asyncio
async def test_download_follows_one_shortcut(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        path = request.url.path
        if path.endswith(f"/files/{FILE_ID}") and request.url.params.get("alt") != "media":
            return httpx.Response(
                200,
                json={
                    "id": FILE_ID,
                    "name": "link",
                    "mimeType": "application/vnd.google-apps.shortcut",
                    "shortcutDetails": {"targetId": TARGET_ID},
                    "trashed": False,
                },
            )
        if path.endswith(f"/files/{TARGET_ID}") and request.url.params.get("alt") == "media":
            return httpx.Response(200, content=b"real")
        if path.endswith(f"/files/{TARGET_ID}"):
            return httpx.Response(
                200,
                json={
                    "id": TARGET_ID,
                    "name": "real.pdf",
                    "mimeType": "application/pdf",
                    "trashed": False,
                },
            )
        return httpx.Response(500, text=f"unexpected {request.url}")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        downloaded = await DriveClient(_creds(tmp_path), client).download(FILE_ID)

    assert downloaded.file_id == TARGET_ID
    assert downloaded.content == b"real"


@pytest.mark.asyncio
async def test_download_rejects_folder(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        return httpx.Response(
            200,
            json={
                "id": FILE_ID,
                "name": "Inbox",
                "mimeType": "application/vnd.google-apps.folder",
                "trashed": False,
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DriveApiError, match="folder"):
            await DriveClient(_creds(tmp_path), client).download(FILE_ID)


@pytest.mark.asyncio
async def test_download_rejects_trashed(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        return httpx.Response(
            200,
            json={
                "id": FILE_ID,
                "name": "gone.jpg",
                "mimeType": "image/jpeg",
                "trashed": True,
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DriveApiError, match="trash"):
            await DriveClient(_creds(tmp_path), client).download(FILE_ID)


@pytest.mark.asyncio
async def test_delete_file_accepts_204(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        assert request.method == "DELETE"
        return httpx.Response(204)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        await DriveClient(_creds(tmp_path), client).delete_file(FILE_ID)


@pytest.mark.asyncio
async def test_delete_file_raises_on_403(tmp_path):
    async def handler(request: httpx.Request) -> httpx.Response:
        if token := _token_ok(request):
            return token
        return httpx.Response(403, text="insufficient permissions")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DriveApiError) as exc:
            await DriveClient(_creds(tmp_path), client).delete_file(FILE_ID)
        assert exc.value.status_code == 403
