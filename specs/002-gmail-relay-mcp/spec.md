# Feature Specification: Gmail & Drive Attachment Relay (MCP)

**Feature Branch**: `002-gmail-relay-mcp`

**Created**: 2026-08-26

## Overview

A receipt often arrives as an email attachment or a Google Drive link rather than
as paper. Re-photographing a screen to get it into the receipt archive is absurd,
and routing the file through an LLM's context is both expensive and lossy — a
multi-megabyte JPEG becomes tokens for no benefit, because nothing about the
*bytes* needs a model's attention. Only the *decision* of which file to relay does.

This service resolves that split. It exposes Gmail search and two relay
operations as MCP tools. The agent sees metadata — subjects, senders, filenames,
sizes — and decides. The bytes travel Gmail/Drive → this server's disk → the
Receipts upload endpoint, and are never returned to the caller.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Relay an emailed receipt into the archive (Priority: P1)

A supplier emails a receipt as a PDF or image attachment. The user asks their
agent to file it. The agent searches the inbox, finds the message, mints a
one-shot upload URL from Receipts, and calls the relay. The attachment lands in
the receipt archive and the source message is marked read so it is not filed twice.

**Why this priority**: This is the entire reason the service exists. Without it
there is no path from an emailed receipt to the archive that doesn't involve a
human re-photographing a screen.

**Independent Test**: Against a Gmail account holding a message with a PDF
attachment and a running Receipts instance, run `search_gmail` → `create_receipt`
(on Receipts) → `relay_attachment`, then confirm the receipt exists in the archive
with correct image bytes and the source message no longer carries `UNREAD`.

**Acceptance Scenarios**:

1. **Given** a Gmail message with an image attachment and a freshly minted Receipts upload URL/token, **When** the agent calls `relay_attachment` with that message's id and attachment id, **Then** the bytes are uploaded to Receipts, the tool returns `{ok: true, bytesUploaded, convertedFromPdf: false, contentType}`, and the message's `UNREAD` label is removed.
2. **Given** the attachment is `application/pdf`, **When** the same call is made, **Then** the PDF's **first page only** is rendered to JPEG at 150 DPI and that JPEG is uploaded, with `convertedFromPdf: true` in the result.
3. **Given** the Receipts upload fails for any reason, **When** the relay runs, **Then** the tool returns `{ok: false, error}`, and the source message is **left unread** so the operation can be retried.
4. **Given** the upload succeeds but marking the message read fails, **When** the relay completes, **Then** the result is still `ok: true` but carries a `warning` — a bookkeeping miss must not be reported as a lost receipt.
5. **Given** any successful or failed relay, **When** the caller inspects the result, **Then** it contains metadata only and never attachment bytes.

---

### User Story 2 - Relay a Google Drive file into the archive (Priority: P1)

The receipt was dropped in Drive, or shared as a Docs link, rather than emailed.
The user hands the agent the link. The agent relays it into the archive, and the
Drive copy is cleaned up so the same file isn't filed twice.

**Why this priority**: Equal-priority sibling to Story 1 — the same need arriving
through a different channel. Drive links are common enough that omitting them
would leave a visible hole.

**Independent Test**: Given a Drive file link and a running Receipts instance,
call `relay_drive_file` and confirm the receipt appears in the archive and the
Drive file is removed.

**Acceptance Scenarios**:

1. **Given** a `drive.google.com` or `docs.google.com` file link, or a bare file id, **When** the agent calls `relay_drive_file`, **Then** the file is downloaded, relayed to Receipts, and the result reports `driveFileId`, `filename`, and `driveFileDeleted`.
2. **Given** the link points at a native Google Doc, Sheet, or Slide deck, **When** the relay runs, **Then** the file is first exported as PDF (a Drawing exports as JPEG) and then follows the normal PDF-to-JPEG path.
3. **Given** the link points at a Drive **folder**, **When** the relay runs, **Then** it is rejected before any download — this tool relays one file, not a directory.
4. **Given** the upload succeeded but the credential lacks permission to delete the Drive file, **When** the relay completes, **Then** the result is `ok: true` with `driveFileDeleted: false` and a `warning` — a failed cleanup is not a failed relay.
5. **Given** the link resolves to a shortcut, **When** the relay runs, **Then** exactly one shortcut hop is followed; a shortcut pointing at another shortcut is rejected.
6. **Given** the target file is in the trash, **When** the relay runs, **Then** it is rejected rather than silently relaying a deleted document.

---

### User Story 3 - Find candidate receipts without spending context on bytes (Priority: P2)

Before relaying anything, the agent needs to see what's there. It searches Gmail
using ordinary Gmail query syntax and gets back a metadata-only listing.

**Why this priority**: A prerequisite for Stories 1 and 2 in practice, but lower
priority as a *deliverable* — it carries no risk of data loss and is the easiest
half to verify.

**Independent Test**: Call `search_gmail` with a query such as
`label:lilith is:unread` and confirm the response lists messages with their
attachment metadata and contains no file content.

**Acceptance Scenarios**:

1. **Given** a Gmail account, **When** the agent calls `search_gmail(q, max_results)`, **Then** it receives each matching message's id, threadId, subject, from, date, labelIds, and an `attachments[]` list of `attachmentId`/`filename`/`mimeType`/`size`.
2. **Given** a message with attachments nested inside multipart parts, **When** it is summarized, **Then** attachments at every nesting depth are found, not just top-level ones.
3. **Given** any search, **When** results are returned, **Then** no attachment bytes are included — the response is safe to place in an LLM's context.
4. **Given** no `max_results` is supplied, **When** the search runs, **Then** at most 25 messages are returned.

---

### User Story 4 - Confine access to the operator alone (Priority: P2)

The server is reachable from the open internet. It holds a credential that can
read an entire mailbox and delete Drive files, so it must admit only the
operator's own agent and nothing else.

**Why this priority**: Not a user-visible feature, but the exposure is real and
the blast radius of getting it wrong is the whole mailbox.

**Independent Test**: Complete the MCP OAuth flow with a Google account absent
from the allowlist and confirm access is refused despite a valid Google login.

**Acceptance Scenarios**:

1. **Given** `GMAIL_RELAY_TRANSPORT=http`, **When** a client authenticates with a Google account whose email is **not** in `GMAIL_RELAY_ALLOWED_EMAILS`, **Then** the token is rejected even though the Google login itself succeeded.
2. **Given** `GMAIL_RELAY_TRANSPORT=http` with any of the OAuth client id, base URL, or allowlist unset, **When** the server starts, **Then** it fails loudly at startup naming the missing variables, rather than starting unprotected.
3. **Given** no transport is configured, **When** the server starts, **Then** it defaults to stdio (local development) with no OAuth requirement.
4. **Given** `GMAIL_RELAY_TRANSPORT` is set to anything other than `stdio` or `http`, **When** the server starts, **Then** it fails with a configuration error.

---

### User Story 5 - Confirm the service is alive and its Google grant still works (Priority: P3)

An operator or deploy script needs to know whether this service is healthy —
including whether its long-lived Google refresh token has been revoked, which is
the most likely way it silently stops working.

**Why this priority**: Diagnostic. Valuable because the specific failure it
catches (revoked refresh token) is otherwise invisible until a relay fails.

**Independent Test**: `GET /health` against a running container with valid
credentials returns `200 ok`; with an invalid client it returns `503` naming the
error.

**Acceptance Scenarios**:

1. **Given** a running server whose credentials refresh successfully, **When** `GET /health` is called, **Then** it returns `200` with body `ok`.
2. **Given** credentials that fail to refresh (revoked, malformed, or missing), **When** `GET /health` is called, **Then** it returns `503` with `{ok: false, error}` describing the failure.

### Edge Cases

- **Attachment exceeds the size limit**: rejected before any conversion or upload work, citing both the actual size and the limit. Default limit 15 MB (`RELAY_MAX_ATTACHMENT_BYTES`).
- **Size-limit mismatch with Receipts**: Receipts itself rejects anything over 8 MB, but this service's default limit is 15 MB — a file between 8 and 15 MB passes the local check and then fails at upload. The failure is reported correctly, but later than it needs to be. See "Known Discrepancies".
- **Unknown or absent MIME type**: if the caller supplies none and Gmail reports none, the type is guessed from the filename; failing that, a non-`image/*` type is labelled `image/jpeg`. This can mislabel a PNG or HEIC — an accepted default, flagged in the README as unverified against Receipts.
- **Attacker-influenced filenames**: any sender can choose an attachment's filename, so no caller- or sender-supplied name is ever used to build a filesystem path. Every scratch file is a fresh UUID stem inside the jail directory.
- **Scratch files left by a crash**: the download directory is wiped on startup, so a hard kill mid-relay cannot accumulate orphaned receipt images on disk.
- **Concurrent relays**: each relay allocates its own UUID stem, and cleanup deletes only that stem's files, so simultaneous relays cannot delete each other's in-flight data.
- **PDF conversion failure or hang**: `pdftoppm` is bounded by a 60-second timeout and a non-zero exit is surfaced as a relay failure, not a partial upload.
- **Drive file already deleted**: a `404` on delete is treated as success — the desired end state (file gone) already holds.
- **PDF with multiple pages**: only page 1 is relayed. A multi-page statement loses pages 2+ silently.

## Requirements *(mandatory)*

### Functional Requirements

**Search**

- **FR-001**: System MUST expose a `search_gmail(q, max_results=25)` tool accepting native Gmail search syntax.
- **FR-002**: Search results MUST include per-message id, threadId, subject, from, date, labelIds, and attachment metadata.
- **FR-003**: System MUST discover attachments at any nesting depth within a message's MIME structure.
- **FR-004**: Search MUST NOT return attachment content under any circumstance.

**Gmail relay**

- **FR-005**: System MUST expose `relay_attachment(message_id, attachment_id, upload_url, upload_token, filename?, mime_type?)`.
- **FR-006**: System MUST resolve the source MIME type in precedence order: caller-supplied → Gmail's reported type → filename-extension guess.
- **FR-007**: System MUST convert a PDF source's first page to JPEG before upload, because the Receipts upload route rejects PDFs outright.
- **FR-008**: System MUST upload via HTTP PUT with a raw binary body, `Authorization: Bearer <upload_token>`, and the resolved image `Content-Type`.
- **FR-009**: System MUST remove the `UNREAD` label from the source message only *after* a successful upload.
- **FR-010**: System MUST report a post-upload mark-read failure as a warning on an otherwise successful result, not as a failure.
- **FR-011**: Relay results MUST contain metadata only (`ok`, `bytesUploaded`, `convertedFromPdf`, `contentType`, optional `warning`/`error`).

**Drive relay**

- **FR-012**: System MUST expose `relay_drive_file(drive_url, upload_url, upload_token, filename?, mime_type?)`.
- **FR-013**: System MUST accept Drive/Docs file links (`/file/d/`, `/document/d/`, `/spreadsheets/d/`, `/presentation/d/`, `/drawings/d/`), `id`/`fileId` query parameters, and bare file ids of 19+ characters.
- **FR-014**: System MUST reject folder links, non-Google hosts, trashed files, and shortcut chains longer than one hop.
- **FR-015**: System MUST export Google-native Docs/Sheets/Slides as PDF, and Drawings as JPEG, since these have no directly downloadable blob.
- **FR-016**: System MUST support files in shared drives, not only My Drive.
- **FR-017**: System MUST delete the Drive file after a successful upload, and MUST report a failed deletion as a warning rather than a failed relay.

**Safety and resource handling**

- **FR-018**: System MUST reject any source exceeding `RELAY_MAX_ATTACHMENT_BYTES` (default 15 MB) before performing conversion or upload.
- **FR-019**: System MUST allocate every scratch file as a fresh UUID stem inside the configured jail directory, never deriving a path from a caller- or sender-supplied name.
- **FR-020**: System MUST delete a relay's scratch files when the relay ends, whether it succeeded or failed.
- **FR-021**: System MUST wipe the download directory at startup.

**Authentication**

- **FR-022**: System MUST hold two unrelated Google OAuth grants: (a) its own Gmail + Drive API access via `gmail.modify` + `drive`, loaded from `GMAIL_CREDENTIALS_PATH`; (b) an MCP-client access gate via `GMAIL_RELAY_OAUTH_GOOGLE_CLIENT_ID/SECRET`.
- **FR-023**: System MUST reject an authenticated Google identity whose email is absent from `GMAIL_RELAY_ALLOWED_EMAILS` — Google login alone is insufficient.
- **FR-024**: System MUST refuse to start in `http` transport if the OAuth client id, base URL, or email allowlist is unset.
- **FR-025**: System MUST cache its Gmail/Drive access token and refresh it ~60 seconds before expiry.
- **FR-026**: System MUST fail with a clear, actionable error if `credentials.json` is absent or missing required fields, naming the init script as the remedy.

**Health**

- **FR-027**: System MUST expose `GET /health` returning `200` when the Google grant refreshes successfully and `503` with the error when it does not.

### Key Entities

- **Gmail message summary**: metadata-only view of one message — id, threadId, subject, from, date, labelIds, and its attachment list. The unit an agent reasons over.
- **Attachment reference**: `attachmentId` + `filename` + `mimeType` + `size`. Identifies bytes without carrying them.
- **Drive file**: resolved id, name, MIME type, and content, after shortcut resolution and any Workspace export.
- **Relay result**: outcome record — success flag, bytes uploaded, whether a PDF was converted, resulting content type, and for Drive relays the file id and deletion status. Deliberately excludes content.
- **Upload handshake**: a short-lived `upload_url` + `upload_token` pair minted by Receipts' `create_receipt`, valid ~30 minutes. This service is a bearer of that grant, never its issuer.
- **Jailed scratch file**: a UUID-stemmed path set inside the download directory, owned by exactly one relay and destroyed with it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A receipt arriving as an email attachment reaches the archive without a human opening, downloading, or re-photographing it.
- **SC-002**: Zero attachment bytes ever appear in an agent's context — relays return metadata only, in every success and failure path.
- **SC-003**: A failed upload never marks its source message read, so no receipt is silently dropped; every failure remains retryable from the same inbox query.
- **SC-004**: A successfully relayed source is not filed twice — the Gmail message is marked read, and the Drive file is deleted when permissions allow.
- **SC-005**: No Google account outside the configured allowlist can invoke any tool, even holding a valid Google login.
- **SC-006**: Every relay, successful or not, leaves the scratch directory free of that relay's files.
- **SC-007**: A revoked Google refresh token is detectable from `/health` alone, without attempting a relay.

## Assumptions

- **Single operator.** Authorisation is a short email allowlist, not a role model. Multi-tenancy is out of scope.
- **Receipts is the only upload target.** The service holds no knowledge of the archive beyond the URL and token it is handed per call; it never mints its own.
- **The agent orchestrates.** This service does not poll, schedule, or decide what to relay. It performs one explicitly requested relay at a time. Scheduling lives in Cowork tasks.
- **First page suffices.** Receipts are assumed to be single-page documents; the multi-page case is knowingly unhandled.
- **The Google grant is minted out of band.** `credentials.json` comes from `scripts/gmail_oauth_init.py`, run once, interactively, on a machine with a browser. The running service only reads and refreshes it.
- **`drive` scope over narrower alternatives.** `drive.readonly` cannot delete; `drive.file` covers only files this app created or the user explicitly opened with it — not a file dropped into Drive and shared as a link. The broad scope is a deliberate trade for the delete-after-relay behaviour.
- **TLS and public hostnames are external.** This service publishes plain HTTP on a host port; `home-gateway` owns the public surface.
- **poppler-utils is present.** PDF conversion shells out to `pdftoppm`, installed in the image.

## Known Discrepancies

These are real inconsistencies between the implementation and its surrounding
documentation or configuration. They are recorded rather than fixed here.

- **DISC-001**: `deploy.sh` (lines 141-147) states gmail-relay "has no documented health endpoint" and only checks that the container is running. The server does implement `GET /health` (`server.py:82`). The deploy script could poll it like the other two services.
- **DISC-002**: `RELAY_MAX_ATTACHMENT_BYTES` defaults to 15 MB (`compose.yaml` sets 15728640) while Receipts rejects anything above 8 MB. Files in that band fail late, at upload, instead of early and locally.
- **DISC-003**: `secrets/gmail-relay.env.example` refers to `deployment/secrets/gmail/gcp-oauth.keys.json`; the actual path is `secrets/gmail/gcp-oauth.keys.json` — a stale `deployment/` prefix.
- **DISC-004**: The `mime_type` fallback to `image/jpeg` for unrecognised non-PDF types is flagged in the README as never verified against Receipts' own handling.
- **DISC-005**: No integration test exercises a real Gmail inbox, a real Drive file, or a real Receipts instance. All tests mock HTTP.
