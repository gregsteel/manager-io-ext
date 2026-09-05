#!/usr/bin/env python3
"""One-time Gmail + Drive OAuth setup — mints deployment/secrets/gmail/credentials.json.

Standard OAuth2 "installed app" loopback flow, stdlib only (no npm, no
klodr/gmail-mcp, no google-auth-oauthlib): open a consent URL, catch Google's
redirect on a local port, exchange the code for tokens, write the refresh
token out. Run this once, interactively, on a machine with a browser — never
inside the gmail-relay container, which only ever reads the resulting file
and refreshes the access token itself at runtime.

Default scopes: gmail.modify (search + mark-read) and drive (download a file
and delete it after a successful Receipts relay). Re-run this script after
any scope change — a refresh token is bound to what was granted at consent.

Usage (from the repo root):
    python3 gmail-relay/scripts/gmail_oauth_init.py [--scopes gmail.modify,drive] [--out PATH]

Reads:  deployment/secrets/gmail/gcp-oauth.keys.json (downloaded from Google
        Cloud Console: APIs & Services > Credentials > OAuth client ID >
        Desktop app). Paths are relative to the repo root.
Writes: deployment/secrets/gmail/credentials.json (mode 0600)
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import stat
import sys
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
SCOPE_PREFIX = "https://www.googleapis.com/auth/"
DEFAULT_KEYS_PATH = Path("deployment/secrets/gmail/gcp-oauth.keys.json")
DEFAULT_OUT_PATH = Path("deployment/secrets/gmail/credentials.json")


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    result: dict[str, str] = {}

    def do_GET(self) -> None:  # noqa: N802 (stdlib method name)
        query = urllib.parse.urlparse(self.path).query
        _CallbackHandler.result = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        if "code" in _CallbackHandler.result:
            body = "<title>gmail-relay</title>Authorized — you can close this tab."
        else:
            body = "<title>gmail-relay</title>Authorization failed — check the terminal."
        self.wfile.write(body.encode())

    def log_message(self, *args: object) -> None:  # silence default request logging
        pass


def _load_client(keys_path: Path) -> dict[str, str]:
    if not keys_path.exists():
        sys.exit(
            f"Missing {keys_path}. Download an OAuth client (Desktop app type) from "
            "Google Cloud Console > APIs & Services > Credentials and save it there."
        )
    data = json.loads(keys_path.read_text())
    client = data.get("installed") or data.get("web")
    if not client:
        sys.exit(f"{keys_path} doesn't look like a Google OAuth client JSON (no 'installed' key).")
    return client


def _run_local_callback_server() -> tuple[http.server.HTTPServer, int]:
    server = http.server.HTTPServer(("127.0.0.1", 0), _CallbackHandler)
    return server, server.server_port


def _exchange_code(client: dict[str, str], code: str, redirect_uri: str) -> dict[str, str]:
    token_uri = client.get("token_uri", "https://oauth2.googleapis.com/token")
    body = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    ).encode()
    req = urllib.request.Request(token_uri, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as resp:  # noqa: S310 (fixed https endpoint)
        return json.loads(resp.read())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scopes",
        default="gmail.modify,drive",
        help="Comma-separated Google API scopes, short form (default: gmail.modify,drive)",
    )
    parser.add_argument("--keys", type=Path, default=DEFAULT_KEYS_PATH)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_PATH)
    args = parser.parse_args()

    client = _load_client(args.keys)
    scopes = [SCOPE_PREFIX + s.strip() for s in args.scopes.split(",") if s.strip()]

    server, port = _run_local_callback_server()
    redirect_uri = f"http://localhost:{port}/oauth2callback"

    auth_url = AUTH_URI + "?" + urllib.parse.urlencode(
        {
            "client_id": client["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "access_type": "offline",
            "prompt": "consent",
        }
    )

    print(f"Opening browser for consent (scopes: {', '.join(scopes)})...")
    print(f"If it doesn't open automatically, visit:\n{auth_url}\n")
    webbrowser.open(auth_url)

    server.timeout = 300
    server.handle_request()
    server.server_close()

    result = _CallbackHandler.result
    if "error" in result:
        sys.exit(f"Google returned an error: {result['error']}")
    code = result.get("code")
    if not code:
        sys.exit("Timed out waiting for the OAuth redirect — no code received.")

    tokens = _exchange_code(client, code, redirect_uri)
    if "refresh_token" not in tokens:
        sys.exit(
            "No refresh_token in the response — Google omits it on repeat consents for "
            "the same account. Revoke prior access at https://myaccount.google.com/permissions "
            "and re-run this script."
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "client_id": client["client_id"],
                "client_secret": client["client_secret"],
                "refresh_token": tokens["refresh_token"],
                "token_uri": client.get("token_uri", "https://oauth2.googleapis.com/token"),
                "scopes": scopes,
            },
            indent=2,
        )
        + "\n"
    )
    os.chmod(args.out, stat.S_IRUSR | stat.S_IWUSR)
    print(f"Wrote {args.out} (mode 0600).")


if __name__ == "__main__":
    main()
