"""Loads and refreshes Gmail OAuth credentials.

Reads the credentials.json shape written by scripts/gmail_oauth_init.py —
not klodr/gmail-mcp's or google-auth-oauthlib's layout. Fields: client_id,
client_secret, refresh_token, token_uri, scopes. This is a *different* OAuth
grant from the one gating MCP-client access to this server itself (see
http_auth.py) — this one is Gmail + Drive API access (gmail.modify + drive), minted once,
offline, via the init script. Drive is required so this server can download
a file and delete it after a successful Receipts relay.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

_REFRESH_SKEW_SECONDS = 60


class GmailCredentialsError(RuntimeError):
    """Missing/malformed credentials.json, or a failed token refresh."""


class GmailCredentials:
    def __init__(self, path: Path) -> None:
        if not path.exists():
            raise GmailCredentialsError(
                f"{path} not found — run scripts/gmail_oauth_init.py first."
            )
        data = json.loads(path.read_text())
        required = ("client_id", "client_secret", "refresh_token", "token_uri")
        missing = [k for k in required if not data.get(k)]
        if missing:
            raise GmailCredentialsError(f"{path} missing required field(s): {', '.join(missing)}")
        self._client_id = data["client_id"]
        self._client_secret = data["client_secret"]
        self._refresh_token = data["refresh_token"]
        self._token_uri = data["token_uri"]
        self._access_token: str | None = None
        self._expires_at_monotonic = 0.0

    async def access_token(self, http_client: httpx.AsyncClient) -> str:
        """Cached access token, refreshed ~60s before expiry."""
        fresh_until = self._expires_at_monotonic - _REFRESH_SKEW_SECONDS
        if self._access_token and time.monotonic() < fresh_until:
            return self._access_token
        resp = await http_client.post(
            self._token_uri,
            data={
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": self._refresh_token,
                "grant_type": "refresh_token",
            },
        )
        if resp.status_code != 200:
            raise GmailCredentialsError(
                f"Gmail token refresh failed: HTTP {resp.status_code} {resp.text}"
            )
        body = resp.json()
        self._access_token = body["access_token"]
        self._expires_at_monotonic = time.monotonic() + float(body.get("expires_in", 3600))
        return self._access_token
