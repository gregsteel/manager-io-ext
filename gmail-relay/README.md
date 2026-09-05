# gmail-relay

MCP server for Cowork: searches Gmail and relays a Gmail attachment or a
Google Drive file straight to `receipt-submission`'s `create_receipt`
upload endpoint, without the bytes ever passing through an LLM's context.

Deployed alongside `manager-mcp` / `receipt-submission` — see the repo-root
`../compose.yaml` and `../README.md` for how this is wired into
the stack (ports, secrets, the two separate Google OAuth clients involved).

## Tools

- `search_gmail(q, max_results=25)` — read-only, metadata only (Gmail search
  syntax, e.g. `label:lilith is:unread`). Each message's `attachments[]` lists
  `attachmentId`/`filename`/`mimeType`/`size`.
- `relay_attachment(message_id, attachment_id, upload_url, upload_token, filename=None, mime_type=None)`
  — downloads the attachment, converts a PDF's first page to JPEG (Receipts'
  upload route rejects PDFs), PUTs it to `upload_url`, and marks the source
  message read only after a successful upload. Returns metadata only
  (`{"ok", "bytesUploaded", "convertedFromPdf", "contentType"}`) — never the
  bytes.
- `relay_drive_file(drive_url, upload_url, upload_token, filename=None, mime_type=None)`
  — same Receipts handshake for a Drive/Docs file link (or a bare file id).
  Folder links are rejected. Native Google Docs/Sheets/Slides are exported
  as PDF first (drawings as JPEG). After a successful upload the Drive file
  is deleted when the token allows it; a permission miss is a warning, not
  a failed relay. Returns metadata only
  (`{"ok", "bytesUploaded", "convertedFromPdf", "contentType", "driveFileId",
  "filename", "driveFileDeleted"}`) — never the bytes.
- `GET /health` — liveness + confirms the Gmail/Drive refresh token still works.

## Auth (two unrelated Google OAuth grants — don't conflate them)

1. **Gmail + Drive API access** (`GMAIL_CREDENTIALS_PATH`) — `gmail.modify`
   (read + mark-read, no permanent delete) plus `drive` (download a file and
   delete it after a successful relay). `drive` rather than `drive.readonly`
   or `drive.file`: delete is a write, and `drive.file` only covers files
   this app created or the user opened with it — not a file dropped in Drive
   and handed over as a link. Minted once via `scripts/gmail_oauth_init.py`
   (enable **both** the Gmail API and the Drive API on that GCP project).
   Re-consent after this scope change — an existing refresh token stays bound
   to `gmail.modify` only. See that script's docstring and
   `../README.md`.
2. **MCP-client access** (`GMAIL_RELAY_OAUTH_GOOGLE_CLIENT_ID/SECRET`,
   `GMAIL_RELAY_ALLOWED_EMAILS`, ...) — gates who may connect to *this server*
   at all, via the same `AllowlistedGoogleProvider` pattern as `manager-mcp`
   (`src/gmail_relay/http_auth.py`, copied from
   `manager-mcp/src/manager_mcp/http_auth.py` with a `GMAIL_RELAY_` prefix).
   This matters because this server is reachable from the open internet and
   must only ever admit Cowork.

## Config (env vars)

| Var | Purpose |
|---|---|
| `GMAIL_CREDENTIALS_PATH` | Path to the `credentials.json` from `gmail_oauth_init.py` |
| `RELAY_DOWNLOAD_DIR` | Jailed scratch dir for in-flight downloads; wiped on startup |
| `RELAY_MAX_ATTACHMENT_BYTES` | Reject anything above this before processing (default 15 MB) |
| `GMAIL_RELAY_TRANSPORT` | `http` for remote MCP (default `stdio`) |
| `GMAIL_RELAY_HTTP_HOST` / `GMAIL_RELAY_HTTP_PORT` | Bind address for `http` transport |
| `GMAIL_RELAY_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | MCP-access OAuth client |
| `GMAIL_RELAY_OAUTH_BASE_URL` | Public base URL this server is reachable at |
| `GMAIL_RELAY_ALLOWED_EMAILS` | Comma-separated allowlist of Google accounts |

## Development

```sh
uv sync --extra dev
uv run pytest
uv run ruff check .
```

Run locally over stdio (no transport env set) against a real `credentials.json`:

```sh
GMAIL_CREDENTIALS_PATH=../secrets/gmail/credentials.json \
RELAY_DOWNLOAD_DIR=/tmp/gmail-relay-dev \
uv run gmail-relay
```

## Not yet done

- Build- and run-verified locally (`docker compose build gmail-relay` +
  running the image with fake credentials — `/health` correctly reports the
  expected refresh failure), but not against a real Gmail account.
- No integration test against a real Gmail inbox, a real Drive file, or a
  real `receipt-submission` instance — only unit tests against mocked HTTP
  (`tests/`). Exercise the actual flows (`search_gmail` → `relay_attachment`,
  and `relay_drive_file`) against Receipts before relying on them.
- `mime_type` inference for non-PDF attachments falls back to `image/jpeg` if
  Gmail doesn't report an `image/*` type and the caller didn't pass one —
  reasonable default, but confirm it doesn't silently mislabel a PNG/HEIC as
  JPEG in a way Receipts cares about.
