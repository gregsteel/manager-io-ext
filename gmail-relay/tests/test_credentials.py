import json

import httpx
import pytest

from gmail_relay.credentials import GmailCredentials, GmailCredentialsError


def _write_creds(path, **overrides):
    data = {
        "client_id": "client-id",
        "client_secret": "client-secret",
        "refresh_token": "refresh-token",
        "token_uri": "https://oauth2.googleapis.com/token",
        "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
    }
    data.update(overrides)
    path.write_text(json.dumps(data))
    return path


def test_missing_file_raises(tmp_path):
    with pytest.raises(GmailCredentialsError):
        GmailCredentials(tmp_path / "does-not-exist.json")


def test_missing_required_field_raises(tmp_path):
    path = _write_creds(tmp_path / "credentials.json", refresh_token="")
    with pytest.raises(GmailCredentialsError):
        GmailCredentials(path)


@pytest.mark.asyncio
async def test_access_token_refreshes_and_caches(tmp_path):
    path = _write_creds(tmp_path / "credentials.json")
    creds = GmailCredentials(path)

    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"access_token": f"token-{calls}", "expires_in": 3600})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        token1 = await creds.access_token(client)
        token2 = await creds.access_token(client)

    assert token1 == "token-1"
    assert token2 == "token-1"  # cached, no second refresh
    assert calls == 1


@pytest.mark.asyncio
async def test_access_token_raises_on_refresh_failure(tmp_path):
    path = _write_creds(tmp_path / "credentials.json")
    creds = GmailCredentials(path)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="invalid_grant")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(GmailCredentialsError):
            await creds.access_token(client)
