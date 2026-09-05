# Feature Specification: Receipt Submission

**Feature Branch**: `003-receipt-submission`

**Created**: 2026-09-05 (moved here from `receipt-submission/docs/SPEC.md`; content current as of 26 August 2026)

## Overview

Getting a paper receipt into a machine-readable archive is a chore nobody does
reliably, so the receipts pile up and the books go stale. This system removes as
much of that friction as possible: point an iPhone at a receipt and it is
detected, deskewed, cleaned up and uploaded with no manual cropping. The server
stores a JPEG and a SQLite row. Claude Cowork then reads, annotates, and posts it
into the books over MCP.

One constraint governs the whole design: **a captured receipt must never be
lost** — not when the server is down, not when the network is absent, not when
the sign-in has expired. §5 exists entirely to satisfy it, and it is the reason
the phone holds and retries rather than reporting a cheerful `Saved.`

**Path convention**: paths in this document (`src/`, `ios/`, `docs/`) are
relative to `receipt-submission/` unless stated otherwise.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Capture a paper receipt without losing it (Priority: P1)

The user points their phone at a receipt. It is found, cropped, cleaned up and
saved. If anything downstream is broken — no signal, server down, expired
sign-in — the receipt is held on the device and retried until it lands, and the
user is told plainly that this happened.

**Why this priority**: This is the governing constraint of the entire system. A
capture flow that silently drops receipts is worse than no capture flow, because
the user stops checking.

**Independent Test**: Capture a receipt with the server unreachable, confirm the
user is told it is held with a count, then restore the server and confirm it
uploads and the local copy is deleted.

**Acceptance Scenarios**:

1. **Given** a receipt in the camera's view, **When** the quad is stable within 0.012 drift for 6 consecutive detections, **Then** capture fires automatically with haptics and a flash, and the app moves to review.
2. **Given** a captured page, **When** the user taps Save and the server accepts it, **Then** the user sees `Saved.` and nothing remains on the device.
3. **Given** the server is unreachable, **When** the user taps Save, **Then** the JPEG is written to `Documents/HeldReceipts/` with an index entry, and the user sees `Couldn't reach the server. 1 receipt couldn't be submitted and will be retried.`
4. **Given** receipts are held, **When** the user opens Home, **Then** the waiting count, the latest error, and **Retry now** / **View waiting receipts** buttons are shown — never a bare `Saved.`
5. **Given** the local persist step *itself* fails, **When** Save runs, **Then** the page is reported failed and left on screen — the only case where the user must act again.
6. **Given** a held queue that drains to empty, **When** retry succeeds, **Then** the stale outage message is cleared from Home.

---

### User Story 2 - Recover from an expired sign-in without a manual sign-out (Priority: P1)

The session secret rotated, or the sign-in came from an older deploy. Every
upload now returns `401` while the phone still holds a token it believes is
valid. The user must be able to get unstuck without knowing any of that.

**Why this priority**: This is a queue-stuck-forever failure that directly
violates the never-lose-a-receipt constraint, and the naive version requires the
user to intuit "sign out first", which nobody does.

**Independent Test**: Rotate `SESSION_SECRET`, attempt an upload, and confirm the
app drops the token and presents Sign in with Google without any manual sign-out.

**Acceptance Scenarios**:

1. **Given** a session the server no longer accepts, **When** any upload path returns `401` — direct Save, **Retry now**, or a background/foreground auto-retry — **Then** `SessionStore.expireSession()` clears the token and sets it as the status message.
2. **Given** the token was cleared this way, **When** Home renders, **Then** it shows **Sign in with Google** directly; signing in and tapping **Retry now** drains the queue.
3. **Given** any stuck state, **When** the user looks for a remedy, **Then** **Sign out** is never required — it exists only for a deliberate, voluntary sign-out.

---

### User Story 3 - Let an AI agent read, annotate, and file receipts (Priority: P1)

Claude Cowork connects over MCP, lists unprocessed receipts, reads the images,
writes back a structured analysis, and marks each one processed once it has been
loaded into the accounting system.

**Why this priority**: The archive only pays for itself if something downstream
consumes it. This is the half that turns stored bytes into bookkeeping.

**Independent Test**: Connect Cowork as a custom connector, call `list_receipts`,
`get_receipt`, `save_analysis` and `mark_processed` against a real receipt, and
confirm each persists.

**Acceptance Scenarios**:

1. **Given** an authenticated MCP session, **When** Cowork calls `list_receipts` with `unprocessed: true`, **Then** it receives matching records ordered by `created_at DESC`, limited to 50 by default and clamped to 1–200.
2. **Given** a receipt id, **When** Cowork calls `get_receipt`, **Then** it receives the record as JSON *and* the JPEG as a base64 image content block, plus a signed 10-minute `imageUrl` that any caller can fetch with a plain unauthenticated `GET`.
3. **Given** Cowork has analysed a receipt, **When** it calls `save_analysis`, **Then** the JSON is persisted without validation, and an already-stringified payload is stored as-is rather than double-encoded.
4. **Given** a receipt loaded into the accounting system, **When** Cowork calls `mark_processed`, **Then** `processed_at` is set and nothing is deleted.
5. **Given** an unauthenticated `/mcp` call, **When** it arrives, **Then** it returns `401` with a `WWW-Authenticate` resource-metadata pointer so Claude can begin OAuth.

---

### User Story 4 - Ingest a receipt that was never on paper (Priority: P2)

The receipt arrived as an emailed PDF or an online invoice. It needs to reach the
same archive without being printed and re-photographed.

**Why this priority**: A large and growing share of receipts are born digital.
Valuable, but the system is still useful without it.

**Independent Test**: Call `create_receipt`, upload bytes to the returned
`uploadUrl` with the returned token, and confirm the receipt appears complete.

**Acceptance Scenarios**:

1. **Given** an MCP session, **When** Cowork calls `create_receipt`, **Then** a placeholder row is created (`size_bytes = 0`, no file) and a 30-minute `uploadToken`, `uploadUrl`, and `curlExample` are returned.
2. **Given** a valid upload token, **When** bytes are PUT or POSTed to `uploadUrl`, **Then** they are attached to that receipt; a second attempt returns `409`.
3. **Given** an upload token, **When** it is used to GET the image, **Then** it is refused — upload tokens and access tokens are not interchangeable.
4. **Given** an HTTPS image URL, **When** Cowork calls `save_receipt`, **Then** the server fetches it under SSRF guards (HTTPS only, public DNS-resolved addresses only, no URL credentials, max 3 redirects, 10s timeout, 8 MB cap, image MIME only).
5. **Given** a desktop browser, **When** the user drags a PDF onto `/upload`, **Then** its first page is converted server-side to JPEG and stored; the MCP tools still reject PDFs outright.

---

### User Story 5 - Correct what the agent got wrong (Priority: P2)

Cowork flags a receipt it could not confidently split. A human opens a link,
fixes the vendor, total, or line items, and saves — and Cowork picks it back up
and posts the corrected version.

**Why this priority**: Without a correction path, every ambiguous receipt is a
dead end. It depends on Stories 1 and 3 existing first.

**Independent Test**: Open `/review/:id` for a flagged receipt, edit a line item,
save, and confirm the receipt remains unprocessed with updated analysis.

**Acceptance Scenarios**:

1. **Given** a receipt with `confidence: "review"` and a non-empty `confidenceReason`, **When** the review page loads, **Then** a "Why this needs review" banner is shown; an `"auto"` receipt with explanatory notes shows no banner.
2. **Given** a receipt whose `analysis_json` is null, **When** the page loads, **Then** a banner makes clear the blank fields mean nothing was saved, not that extraction found nothing.
3. **Given** an edited split, **When** the user saves, **Then** only `analysis_json` is rewritten — `processed_at` is deliberately left alone so Cowork picks the receipt up again as unprocessed.
4. **Given** item edits, **When** they are saved, **Then** each item's `category` round-trips unedited, so a human correcting a description does not blank the category Cowork assigned.
5. **Given** items that do not sum to the declared total, **When** the form renders, **Then** the running total flags in red.
6. **Given** a processed receipt, **When** the page renders, **Then** no Delete button is shown, and `DELETE` returns `409` until it is marked unprocessed.

---

### User Story 6 - Restrict the archive to its owner (Priority: P2)

Receipts are financial records. Only allowlisted people, and only the user's own
agent, may read or write them.

**Why this priority**: Real exposure — an internet-reachable service holding
financial documents — though the allowlist is deliberately simple.

**Independent Test**: Sign in with a non-allowlisted Google account and confirm
refusal; call `/mcp` with a session JWT and confirm it is rejected.

**Acceptance Scenarios**:

1. **Given** a Google account absent from `ALLOWED_USERS`, **When** it signs in, **Then** access is denied; an empty or missing allowlist denies everyone rather than allowing everyone.
2. **Given** an address removed from `ALLOWED_USERS`, **When** the next request arrives, **Then** it is refused — `getSession()` re-checks the allowlist per request, which is the only revocation mechanism for a 400-day session.
3. **Given** a session JWT, **When** it is presented to `/mcp`, **Then** it is rejected; MCP access tokens are likewise not accepted as app sessions.
4. **Given** an unauthenticated request, **When** it targets `GET /api/receipts/:id/image`, **Then** it succeeds only with a receipt-scoped `image-access` token, and the request gate defers rather than blanket-rejecting it.

### Edge Cases

- **Held receipt uploaded days later**: the phone sends `capturedAt` as local wall-clock time with an explicit offset, so the stored filename reflects when the receipt was *taken*, not when it arrived. `created_at` and `filename` legitimately disagree.
- **Permanently rejected receipt**: retries are unbounded and never give up. A `400` for a non-image retries forever at one request per minute — cheap, and strictly preferable to discarding an image.
- **Oversized scan**: an nginx `413` is re-encoded smaller on the next retry. Receipts held from before downscaling existed are re-encoded on retry.
- **Double-encoded analysis JSON**: Cowork has been observed passing `analysis` as an already-stringified string. `normalizeAnalysisJson` stores it as-is, and `parseStoredJson` unwraps up to three layers, self-healing rows already corrupted.
- **Numeric-looking reference**: a value like `"0020012364141"` is coerced to string rather than dropped — as a bare JSON number literal it is invalid (leading zeros), so a model treating it as numeric would silently lose them.
- **No document detected**: the frame is used uncropped rather than mis-cropped.
- **Detection dropout**: up to 4 consecutive missed frames are tolerated before the overlay clears, so the outline does not flicker.
- **A different sheet enters frame**: drift above 0.2 replaces the quad outright and resets stability rather than smoothing between two documents.
- **Placeholder with no image yet**: `GET .../image` returns `404` when the row exists but nothing has been attached.
- **Schema drift**: `processed_at` was added after the table existed in production, so `openDb()` inspects `PRAGMA table_info` and runs `ALTER TABLE` on first connect — `CREATE TABLE IF NOT EXISTS` does not alter existing tables.
- **Partial multi-page save**: successful uploads and held receipts can appear together in one status message.

## Requirements *(mandatory)*

### Functional Requirements

**Capture**

- **FR-001**: The system MUST detect, deskew, and clean up a receipt on-device with no manual cropping.
- **FR-002**: Auto-capture MUST fire only when the detected quad is within usable area bounds and stable across consecutive detections, and MUST show that progress rather than firing unannounced.
- **FR-003**: Capture time MUST be stamped when the shutter fires, not when Save is tapped, and every downstream identifier MUST derive from it.
- **FR-004**: Processing MUST flatten extended-range capture data, perspective-correct, desaturate, and auto-level before encoding.
- **FR-005**: Encoding MUST keep the file under 700 KB by downscaling the longest edge to 1800 px and stepping JPEG quality down.

**Never lose a receipt**

- **FR-006**: Any upload failure MUST persist the JPEG and an index entry to the device.
- **FR-007**: The user MUST be told, with a count, both after Save and on Home, whenever anything is held.
- **FR-008**: Held receipts MUST be retried on launch, on foreground, every 60 s while open, opportunistically via background refresh, and manually.
- **FR-009**: Retries MUST be unbounded and MUST NOT discard an image.
- **FR-010**: A successful upload MUST delete the local copy.
- **FR-011**: A `401` from any upload path MUST clear the stored token so the user can recover without a manual sign-out.
- **FR-012**: The system MUST distinguish an outage (no reply) from a rejection (a reply), and MUST NOT surface raw HTML error pages.

**Storage**

- **FR-013**: The server MUST store one JPEG per receipt row on disk plus a row in SQLite, and MUST write the file before the insert, unlinking it if the insert fails.
- **FR-014**: The server MUST NOT perform OCR or accounting logic — it stores bytes and metadata; interpretation is Cowork's and returns as opaque JSON.
- **FR-015**: Stored analysis MUST be read leniently (aliased field names) and written back in a stable shape, preserving unrecognised keys untouched.

**HTTP API**

- **FR-016**: `POST /api/send` MUST accept multipart image or PDF uploads under 8 MB, rejecting empty files and other content types with `400`.
- **FR-017**: A PDF submitted to `/api/send` MUST be converted server-side to a JPEG of its first page, returning `400` with the conversion error rather than storing an unreadable row.
- **FR-018**: `GET /api/receipts/:id/image` MUST accept a session JWT **or** a receipt-scoped `image-access` token.
- **FR-019**: `PUT`/`POST /api/receipts/:id/image` MUST accept a session JWT **or** a receipt-scoped `image-upload` token, and MUST be one-shot (`409` if an image exists).
- **FR-020**: `DELETE /api/receipts/:id` MUST refuse with `409` while `processed_at` is set.
- **FR-021**: `POST /api/receipts/:id/review` MUST rewrite only the analysis and MUST NOT mark the receipt processed.

**MCP**

- **FR-022**: `/mcp` MUST speak JSON-RPC 2.0 over plain HTTP POST, remaining stateless, handling `initialize`, `tools/list`, `tools/call` and `ping`.
- **FR-023**: The server MUST expose exactly six tools: `list_receipts`, `get_receipt`, `create_receipt`, `save_receipt`, `save_analysis`, `mark_processed`.
- **FR-024**: `get_receipt` MUST return both a base64 image block and a signed, unauthenticated, 10-minute `imageUrl`, because Cowork can view an image block but cannot read its base64 back out to hand to another MCP server.
- **FR-025**: `save_receipt`'s URL fetch MUST be SSRF-guarded.
- **FR-026**: MCP tools MUST reject `application/pdf` outright.
- **FR-027**: Upload tokens and access tokens MUST NOT be interchangeable, and neither MUST be accepted as an app session.

**Authorisation**

- **FR-028**: Human sign-in MUST be Google OAuth gated by a comma-separated `ALLOWED_USERS` allowlist, compared lowercased, denying everyone when empty.
- **FR-029**: Sessions MUST be self-contained HS256 JWTs with no server-side session table, and the allowlist MUST be re-checked on every request.
- **FR-030**: MCP clients MUST authenticate via the MCP authorization spec (RFC 9728 + RFC 8414 + authorization code + PKCE S256), with CIMD first and DCR as fallback.
- **FR-031**: The consent screen MUST show the `client_id` hostname rather than a self-asserted name, and MUST warn on loopback redirects.
- **FR-032**: Refresh tokens MUST rotate, deleting the previous `jti` before issuing a new pair.

### Key Entities

- **Receipt**: one row plus one JPEG. Carries id, upload time, submitter, capture-derived filename, MIME type, size, and optional analysis and processed timestamps.
- **Captured page**: an on-device image with the capture instant stamped at shutter time. Survives review, retake, and arbitrary offline delay.
- **Held receipt**: a JPEG plus `{id, capturedAt, attempts, lastError}` on the phone, awaiting a server that will accept it.
- **Analysis**: opaque JSON from Cowork, read leniently and written back in a stable shape. `confidence`/`confidenceReason` are read-only signals set by Cowork's own task configuration, not part of this repo's contract.
- **Session JWT**: a 400-day self-contained human credential, revocable only by allowlist removal.
- **MCP access token**: a 60-minute agent credential, audience-scoped to the MCP resource URL.
- **Image tokens**: two disjoint receipt-scoped grants — `image-access` (10 min, read) and `image-upload` (30 min, write-once).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No captured receipt is ever lost — every failure path either uploads eventually or tells the user explicitly that it did not.
- **SC-002**: A receipt is captured and saved without the user cropping, rotating, or adjusting anything.
- **SC-003**: A user whose sign-in has expired recovers by signing in once, with no prior sign-out and no knowledge of why it broke.
- **SC-004**: A held receipt's stored filename reflects when it was taken, even if it uploads days later.
- **SC-005**: An agent can go from "which receipts need work" to "this one is filed" without a human touching the server.
- **SC-006**: No non-allowlisted Google account can read or write any receipt.
- **SC-007**: A receipt corrected by a human is picked back up by the agent and posted, without the human needing to post it.
- **SC-008**: A receipt image is never exposed to an unauthenticated caller except through a short-lived, receipt-scoped signed link.

## Assumptions

- **Single user, small allowlist.** Authorisation is a hardcoded email list, not a role model. Multi-tenancy is out of scope.
- **iPhone only.** iOS 17+, portrait-only. No Android, no iPad.
- **Browser capture is not coming back.** An OpenCV.js pipeline was tried and deleted; Vision on-device beat it decisively.
- **No device-side email fallback.** Offline uploads are held on the phone and retried.
- **The server does not interpret receipts.** No OCR, no accounting logic.
- **Receipts are single-page.** Only a PDF's first page is rendered; the data model is one JPEG per row.
- **TLS is the reverse proxy's job.** The container serves plain HTTP on 55666 and must not be exposed directly.
- **Cowork's review criteria live in Cowork**, not this repo — `confidence`/`confidenceReason` arrive from its task configuration.

---

# Detailed behaviour as built

*The sections below are the original specification, preserved in full. They
describe behaviour as built, with the rationale behind it. Keep them accurate:
whenever behaviour, architecture, auth, APIs, data model, or configuration
change, update this document in the same change.*

*`receipt-submission/README.md` covers setup and operation.*

## 1. Purpose and scope

A single-user (small-allowlist) system for getting paper receipts into a
machine-readable archive with as little friction as possible:

1. Point an iPhone at a receipt. It is detected, deskewed, cleaned up and
   uploaded without any manual cropping.
2. The server stores the JPEG on disk and a row in SQLite.
3. Claude Cowork reads, annotates, and can ingest online receipts over MCP.

The governing constraint is that **a captured receipt must never be lost**, even
if the server is down, the network is absent, or the sign-in has expired. Section
5 exists entirely to satisfy that constraint.

### Non-goals

- Multi-tenant use. Authorisation is a hardcoded email allowlist.
- Browser capture. Removed deliberately; see §8.
- Device-side email (Resend or otherwise). Offline uploads are held on the phone
  and retried; the user is told clearly, with a count, both after Save and on
  Home. See §5.
- OCR or accounting logic on the server. The server stores bytes and metadata;
  interpretation happens in Cowork and comes back as opaque JSON (§6.2).
- Android or iPad. The iOS target is iPhone-only, portrait-only.

---

## 2. Components

| Component | Technology | Location |
|---|---|---|
| iPhone app | Swift 5, SwiftUI, AVFoundation, Vision, iOS 17+ | `ios/` |
| Web/API server | Next.js 16.3.0, React 19.2.8, Node 22 | `src/` |
| Datastore | `node:sqlite` (built-in) + JPEGs on disk | `$DATA_DIR` |
| Analysis client | Claude Cowork over remote MCP | — |

The server is stateless apart from `$DATA_DIR`; it runs as one container on a
home server behind an HTTPS reverse proxy.

### 2.1 Topology

```
 iPhone (Receipts.app)                          Claude Cowork
   │                                                  │
   │ POST /api/send            ┌──────────────────┐   │ POST /mcp
   │ (session JWT, Bearer)     │  Next.js :55666   │   │ (OAuth access token)
   ├──────────────────────────▶│                  │◀──┤
   │                           │  $DATA_DIR       │   │  read/annotate tools
   │ on failure:               │   receipts.db    │   │  + create_receipt /
   │ hold locally              │   files/*.jpg    │   │    save_receipt
   ▼                           └──────────────────┘   │  PUT image (upload JWT)
 Documents/HeldReceipts/  ── retried until accepted

```

There is no off-device email path. A failed upload is held on the phone and
surfaced clearly in the UI until the server accepts it. Cowork can also ingest
receipts via `create_receipt` then HTTP upload, or via `save_receipt` (§8) —
local filesystem paths are not accepted over MCP itself; Cowork uses curl (or
similar) against the signed upload URL.

---

## 3. Actors and authorisation

Two unrelated credential types, because the two callers have different threat
models and lifetimes: humans get long-lived session JWTs via Google sign-in,
and Claude Cowork gets short-lived MCP OAuth access tokens. There is no
separate machine credential — the receipts REST API was retired once MCP
covered everything (§8).

### 3.1 Human users — Google OAuth → session JWT

Sign-in is Google OAuth 2.0 (`openid email profile`, `access_type=online`,
`prompt=select_account`). The email must appear in `ALLOWED_USERS`
(comma-separated, compared lowercased). An empty or missing allowlist denies
everyone rather than allowing everyone.

The session is a self-contained **HS256 JWT** signed with `SESSION_SECRET` via
`jose` — there is no server-side session table. Claims are `email`, optional
`name` and `picture`, plus `iat`/`exp`. Lifetime is **400 days**, chosen so the
phone effectively never has to re-authenticate; revocation is by removing the
address from `ALLOWED_USERS`, which `getSession()` re-checks on every request.

CSRF for the OAuth round trip is a second short-lived JWT (`purpose: "oauth"`,
10 minutes) held in the `oauth_state` cookie and compared against the returned
`state` parameter.

Two delivery mechanisms for the same JWT:

- **Browser** — `session` cookie: `httpOnly`, `sameSite=lax`, `path=/`, and
  `secure` only when `GOOGLE_REDIRECT_URI` is `https://` (so plain-HTTP local
  Docker still works).
- **iPhone** — `GET /auth/google?native=1` sets an `oauth_native=1` marker
  cookie; the callback then redirects to `NATIVE_APP_REDIRECT` (default
  `receipts://auth`) with the JWT in a `token` query parameter, and sets no
  cookie. The app presents this as `Authorization: Bearer <jwt>`.

`getSession(request)` accepts either: it prefers a `Bearer` token from the
`Authorization` header and falls back to the `session` cookie.

### 3.2 MCP OAuth (Cowork / Claude.ai)

Claude's custom-connector UI only offers OAuth Client ID/Secret, not a Bearer
header. Cowork therefore authenticates to `/mcp` with the MCP authorization
spec (RFC 9728 protected-resource metadata + RFC 8414 authorization-server
metadata + authorization code + PKCE S256).

Unauthenticated `/mcp` calls return `401` with
`WWW-Authenticate: Bearer … resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.
Claude then discovers:

| Path | Document |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | resource = `https://<host>/mcp`, this origin as authorization server |
| `GET /.well-known/oauth-authorization-server` | issuer, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, S256 PKCE, CIMD + DCR |

Client registration is **CIMD first** (`client_id_metadata_document_supported`
and `token_endpoint_auth_methods_supported` includes `none`). Claude's
`client_id` is an HTTPS metadata URL; the server fetches it, requires
`client_id` to match the URL, and checks `redirect_uri` against that document
(loopback ports ignored per RFC 8252, including `localhost` for Claude Code).
`POST /oauth/register` remains as Dynamic Client Registration fallback.

`GET /oauth/authorize` requires an allowlisted Google session. Unsigned users
are sent through `/auth/google?next=/oauth/authorize?…` and returned to the
consent screen. The consent page shows the **client_id hostname** (not a
self-asserted name) and the redirect hostname; loopback redirects get an extra
warning. Allow issues a one-time authorization code (JWT, 10 minutes) and
`303`s to the client. Deny returns `error=access_denied`.

`POST /oauth/token` accepts `application/x-www-form-urlencoded` for
`authorization_code` (PKCE S256) and `refresh_token`. Access tokens are HS256
JWTs (`purpose: mcp_access`, `aud` = the MCP resource URL, 60 minutes).
Refresh tokens rotate: the previous `jti` is deleted from SQLite before a new
pair is issued. Session JWTs (`purpose: session`, or no purpose for tokens
issued before this field existed) are not accepted as MCP access tokens, and
MCP tokens are not accepted as app sessions.

OAuth clients, unused auth-code ids, and refresh-token ids live in the same
SQLite file as receipts (`oauth_clients`, `oauth_auth_codes`,
`oauth_refresh_tokens`).

### 3.3 Request gate

`src/proxy.ts` (Next.js 16 replaces `middleware.ts` with `proxy.ts`) runs ahead
of all routes. Paths under `/login`, `/auth/`, `/health`, `/api/health`,
`/mcp`, `/oauth/`, `/.well-known/`, `/manifest.webmanifest`, `/icon` and
`/apple-icon` pass through — for the MCP prefix this only defers the decision;
`/mcp` itself still requires a valid MCP access token. `/api/receipts/:id/image`
(GET, PUT, and POST) gets the same "defers the decision" treatment via a
dedicated regex (`PUBLIC_PATTERNS`, not a prefix — every other
`/api/receipts/:id/*` route stays behind the blanket session-or-Bearer check
below): the route itself requires a valid session *or* a receipt-scoped
`image-access` token on GET, *or* a receipt-scoped `image-upload` token on
PUT/POST (§7, §8). The GET exemption exists because `manager-mcp` fetches
`get_receipt`'s `imageUrl` unauthenticated — no cookie, no `Bearer` header —
which the blanket check would otherwise reject before the route's own token
verification ever ran (exactly this bug shipped once: the route-level check
was correct in isolation but unreachable until this exemption was added).
PUT/POST needs the same deferral so Cowork's curl can present only an
`image-upload` Bearer (not a session cookie).

Everything else requires a valid allowlisted `session` cookie. Failing that, an
`/api/*` path with any `Bearer` header is allowed through for its handler to
judge, other `/api/*` paths get `401`, and page routes redirect to `/login`.

### 3.4 Authorisation matrix

| Path | Credential |
|---|---|
| `POST /api/send` | Session JWT (cookie or Bearer) |
| `GET /api/receipts/:id/image` | Session JWT, or a receipt-scoped image-access token (`?token=`) |
| `PUT`/`POST /api/receipts/:id/image` | Session JWT, or a receipt-scoped image-upload token (`Authorization: Bearer` or `?token=`) |
| `POST /mcp` | MCP OAuth access token |
| `GET /.well-known/oauth-*`, `POST /oauth/register`, `POST /oauth/token` | None |
| `GET /oauth/authorize`, `POST /oauth/approve` | Google session (consent) |
| `GET /` | Session cookie |
| `/login`, `/auth/*`, `/health`, `/api/health`, icons, manifest | None |

### 3.5 iOS server configuration

There is no built-in or build-time default server — `APIClient.baseURL`
(`ios/Receipts/APIClient.swift`) reads only a `UserDefaults` value the user
enters themselves. On first launch, `ContentView` renders
`ServerSettingsView(isInitialSetup: true)` instead of the camera/home screen
until one is saved; that mode has no Cancel button and no way to dismiss
without entering a URL. A gear icon on the home screen reopens the same view
(`isInitialSetup: false`) to change or, via **Remove server**, clear it —
clearing drops the app back into first-run setup.

Because the session JWT is only valid against the server that issued it,
saving a different URL or removing it always calls `SessionStore.signOut()`.

The one exception is CI-built installs (§10.3): `ReceiptsApp.init()` calls
`APIClient.bootstrapDefaultServerIfNeeded()`, which — exactly once per
install, tracked by a separate `UserDefaults` flag so it never re-fires —
seeds `baseURL` from an optional `RECEIPTS_DEFAULT_SERVER_URL` Info.plist
key, present only when `ci_post_clone.sh` injected it. That skips first-run
setup entirely for that build. Removing the server afterwards still sticks;
it is not re-seeded on a later launch. Builds without the CI variable (local
builds, other forks) are unaffected — `baseURL` stays `nil` until the user
enters one, same as before.

---

## 4. Capture pipeline (iOS)

Capture is a purpose-built AVFoundation camera rather than VisionKit's
`VNDocumentCameraViewController`. VisionKit framed receipts well but owned the
post-capture flow — it returned to scanning instead of surrendering to a review
screen — and handed back extended-range images that encoded to near-black JPEGs.
The custom camera exists to own the capture lifecycle and the colour pipeline.

### 4.1 Live viewfinder — `ios/Receipts/ScanCameraView.swift`

An `AVCaptureSession` at `.photo` preset on the back wide-angle camera, with
continuous autofocus and auto-exposure, feeding two outputs:

- `AVCapturePhotoOutput` with quality prioritisation, for the still.
- `AVCaptureVideoDataOutput` (32BGRA, late frames discarded) for live detection.
  Critically, `automaticallyConfiguresOutputBufferDimensions = false` and
  `deliversPreviewSizedOutputBuffers = true`: Vision analyses preview-sized
  buffers, not full-resolution ones. Without this the preview is visibly
  unresponsive.

Detection runs `VNDetectDocumentSegmentationRequest` throttled to **12 Hz**,
skipped entirely while a previous frame is in flight or a capture is underway.
Observations below **0.3** confidence are discarded.

Preview, video-data, and photo connections all use `videoRotationAngle = 90`, so
live frames and stills are already upright. Vision runs with orientation `.up`,
keeping its corners in that same portrait space. The overlay maps each corner
into the letterboxed video rect (`layerRectConverted(fromMetadataOutputRect:)`
of the unit square, with Vision's bottom-left origin flipped to top-left). It
does **not** use `layerPointConverted(fromCaptureDevicePoint:)`, which speaks
sensor-space coordinates and was the cause of the skewed/partial overlay when
Vision results were already upright.

Corners are held in a `Quad` (Vision normalised space, origin bottom-left) and
smoothed with an exponential moving average at factor **0.4**, but only when the
new observation is within **0.2** drift of the current one — a larger jump means
a different sheet, so the quad is replaced outright and stability resets. Drift
is the maximum per-corner Euclidean distance. Up to **4** consecutive missed
frames are tolerated before the overlay clears, so a brief detection dropout
does not make the outline flicker.

The preview uses `videoGravity = .resizeAspect`, so the 4:3 frame is letterboxed
with black bars rather than cropped to fill a tall screen. Aspect-fill hid the
sides of what the still would actually capture, meaning the user framed against a
narrower view than the photo taken. All chrome lives in the bars: an `xmark`
close button and the Auto/Manual toggle at the top, the torch and shutter at the
bottom.

The overlay is a single `CAShapeLayer` filling the detected quad with `systemTeal`
at 28% behind a 5 pt stroke, so the sheet is highlighted rather than the rest of
the frame being dimmed — an earlier 40% black mask outside the quad muddied the
whole scene and made the outline read as a stray box. Path changes are
interpolated over one detection interval inside a `CATransaction`, because a shape
layer otherwise snaps between paths and 12 Hz updates visibly step. The layer
fades in and out over 0.18 s rather than appearing abruptly.

Hints sit in a translucent black pill so they stay legible over both the
letterbox bar and the frame: `Move closer` below **0.12** normalised area,
`Move back` above **0.92**, `Receipt found — hold steady` when usable but not yet
stable, and `Tap to capture` in manual mode.

### 4.2 Auto-capture

In Auto mode (the default; a capsule toggle switches to Manual), a capture fires
when the quad has been usable — area between **0.12** and **0.92** — and within
**0.012** drift for **6** consecutive detections, roughly half a second at 12 Hz.
Firing gives medium impact haptics and a white flash at 0.85 alpha fading over
0.25 s, matching the manual shutter exactly.

That half second is shown, not just waited out: a teal ring winds clockwise from
the top around the shutter as `steadyFrames` accumulates, so the capture is
visible coming rather than firing unannounced. It is hidden in Manual mode and
unwinds whenever stability resets.

One capture ends the camera session and returns to the review screen. There is
no multi-shot mode inside the camera; extra pages are explicit user actions.

### 4.3 Processing — `ios/Receipts/ReceiptImage.swift`

`process(_:)` runs off the main thread, in order:

1. **Normalise orientation.** Pass through if already `.up`; otherwise
   re-rasterise opaque at scale 1 with `preferredRange = .standard`. This is
   where extended-range (HDR) capture data is flattened, and it is what fixed
   the near-black JPEGs.
2. **Detect the document** again, stricter than the live pass — confidence above
   **0.4**, area between **0.12** and **0.98**. If nothing qualifies, the frame
   is used uncropped rather than mis-cropped.
3. **Perspective-correct** to a rectangle via `CIPerspectiveCorrection` with
   `crop = true`.
4. **Desaturate** — receipts carry no useful colour, and grayscale makes the
   level maths below predictable.
5. **Auto-level.** Build a 256-bin BT.709 luma histogram from a thumbnail whose
   longest side is 120 px, take the **5th** percentile as black and the **93rd**
   as white, then widen to at least 32 levels apart if the frame is flat.
   Stretch with `CIColorMatrix` (`scale = 255 / (white - black)`), then apply
   contrast **1.18** and brightness **+0.02**.

The `CIContext` pins both working and output colour space to sRGB, so the
histogram is measured in the same space the correction is applied in.

Encoding downscales the longest edge to **1800 px** and JPEG-compresses at
**0.72** (then 0.55, then 0.4) so the file stays under **700 KB**. Full-resolution
stills at quality 0.85 were several megabytes and nginx’s default 1 MB body
limit rejected them with **413**. The home-gateway receipts vhost now sets
`client_max_body_size 10m` (the API allows 8 MB). 1800 px is still more than
enough to read a thermal receipt. Receipts already held on the phone from before
downscaling are re-encoded on retry.

### 4.4 Review — `ios/Receipts/ContentView.swift`

Home shows a single 184 pt circular **Capture Receipt** button in the app accent
`#0D6E6E`. After a capture the app switches to review, where pages are a paged
`TabView` and the actions are **Discard**, **Retake** (replaces the visible
page), **Add page** (appends), and **Save**.

Each page is a `CapturedPage { id, capturedAt, image }`. `capturedAt` is stamped
when the shutter fires, not when Save is tapped, so it survives an arbitrarily
long review, a retake, and any amount of time held offline. Every downstream
identifier derives from it (§5.3).

Save uploads each page independently. Pages are cleared only if nothing failed
outright, so a hard failure leaves the images on screen.

**Status after Save** (§5.2):

| Outcome | Message |
|---|---|
| All uploaded | `Saved.` / `Saved N pages.` |
| Held for retry | `{reason}. N receipt(s) couldn't be submitted and will be retried.` |
| Encode / disk failure | First failure string (e.g. `Could not encode that photo.`) |

`{reason}` is one of `Couldn't reach the server`, `Sign-in expired`, or
`Server refused the upload`.

**Home dashboard** while anything is held: the same
`N receipt(s) couldn't be submitted and will be retried` line (with count), the
latest upload error, and two full-width rounded accent buttons — **Retry now** /
**Retrying…** and **View waiting receipts** — matching the Capture Receipt
accent. There is no email fallback and no silent `Saved.` when the server was
unreachable. When the held queue drains to empty (manual or automatic retry),
any leftover hold/error status under Capture is cleared so the dashboard does
not keep showing a stale outage message.

---

## 5. Submission and offline resilience

### 5.1 Normal path

`POST /api/send` as `multipart/form-data` with a `capturedAt` field and a
`receipt` file, bearing the session JWT, 30 s timeout. On `2xx` the page is done
and the user sees `Saved.`

### 5.2 Failure path

Any upload failure — connection refused, timeout, DNS failure, `401`, `500` —
triggers a local hold:

1. **Persist.** The JPEG is written to `Documents/HeldReceipts/<uuid>.jpg` with a
   `HeldReceipt { id, capturedAt, attempts, lastError }` entry appended to
   `index.json` alongside it. If this write also fails, the page is reported as
   failed and left on screen — the only case where the user must act again.
2. **Tell the user.** After Save:
   `Couldn't reach the server. 1 receipt couldn't be submitted and will be retried.`
   (or `Sign-in expired` / `Server refused the upload` as the leading clause).
3. **Retry** until the server accepts it, then delete the local copy.

Home keeps the same message with the waiting count and rounded **Retry now** /
**View waiting receipts** buttons whenever anything is held. The latest upload
error is shown under that line (e.g. `Sign-in expired.` or `The scan is too
large for the server.`). HTML error pages from nginx are not shown. **Retry
now** also writes a status line so a silent failure can no longer hide; on
full success it shows `Saved.` / `Saved N receipts.` Background and
foreground auto-retries that empty the queue clear any prior hold/error
status on Home. **View waiting receipts** opens a sheet (`HeldReceiptsView`)
listing each held item with thumbnail, capture time, attempt count, and last
error. Swipe to delete, open for a full-size preview with **Remove from
phone**, or **Clear all**. Removal deletes the JPEG and index entry; that
receipt will not be uploaded. Successful uploads and held receipts can both
appear in one status when a multi-page Save partially fails.

A common stuck-retry case is a session JWT the server no longer accepts (secret
rotated, or sign-in from an older deploy): every `/api/send` returns `401`
even though the token is still in `UserDefaults`. The app does not require a
manual sign-out to recover from this: any `401` — from a direct Save, from
**Retry now**, or from a background/foreground auto-retry — calls
`SessionStore.expireSession()`, which clears the token exactly like
`signOut()` does and sets it as the status message. The next time Home
renders it shows the **Sign in with Google** button directly; the user signs
in once and taps **Retry now** to drain the queue. There is no scenario where
they need to tap **Sign out** first — that button now exists only for a
deliberate, voluntary sign-out.

`APIClient.UploadError` carries a nil `status` when no reply arrived at all,
which is what separates a genuine outage from a server that answered with a
rejection.

### 5.3 Capture-time filenames

A held receipt may upload days later, so the phone sends `capturedAt` as local
wall-clock time with an explicit offset (`2026-08-17T08:41:23+10:00`). The
server reads those fields with a regex rather than parsing to a `Date`, so the
stored filename stays `receipt_2026-08-17_08-41-23.jpg` and matches when the
receipt was taken. A missing or malformed `capturedAt` falls back to server time.
`ReceiptStamp` in `APIClient.swift` builds both the wire value and the client
filename.

### 5.4 Retry schedule

`retryHeld()` walks the queue, re-uploading each entry and incrementing
`attempts`. On success it deletes the local files. A re-entrancy guard prevents
overlapping runs.

| Trigger | Timing |
|---|---|
| App launch | Immediately |
| Return to foreground | On `scenePhase == .active` |
| While app is open | Every 60 s |
| Background app refresh | `<bundle id>.retry`, no earlier than 15 min |
| Manual | **Retry now** on Home |

Background refresh is opportunistic — iOS decides whether and when to run it —
so it is a bonus rather than a guarantee. Opening the app is the reliable
trigger, which is why the waiting count is surfaced on Home. This requires
`UIBackgroundModes: fetch` and `BGTaskSchedulerPermittedIdentifiers` in
`Info.plist`.

Retries are unbounded and never give up. A permanently rejected receipt (say a
`400` for a non-image) would retry indefinitely, which is cheap at one request
per minute and strictly preferable to discarding an image. Oversized scans that
hit nginx's 413 are re-encoded smaller on the next retry.

---

## 6. Data model

### 6.1 Layout

`DATA_DIR` (default `{cwd}/data`, `/app/data` in Docker) contains
`receipts.db` and `files/<uuid>.jpg`. Images are always written with a `.jpg`
extension regardless of declared MIME type. SQLite runs in WAL mode with one
connection cached on `globalThis` so dev hot-reload does not leak handles.

### 6.2 Schema

Single table `receipts`, with an index on `created_at`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | TEXT | no | Primary key, `randomUUID()`; also the image filename |
| `created_at` | TEXT | no | ISO-8601, set at insert — **upload** time, not capture time |
| `submitted_by` | TEXT | no | Email from the session or MCP OAuth caller |
| `filename` | TEXT | no | `receipt_<stamp>.jpg`, derived from capture time |
| `mime_type` | TEXT | no | Defaults to `image/jpeg` |
| `size_bytes` | INTEGER | no | `0` until an image is attached (`create_receipt` placeholder) |
| `analysis_json` | TEXT | yes | Opaque JSON from Cowork |
| `analysed_at` | TEXT | yes | ISO-8601, set when analysis is saved |
| `processed_at` | TEXT | yes | ISO-8601, set when Cowork marks the receipt processed downstream |

`created_at` and `filename` can disagree for a receipt that was held offline:
the row records when it arrived, the filename when it was taken. Capture time is
deliberately not written to a column of its own — nothing consumes it yet, and
the filename already carries it.

`analysis_json` is whatever Cowork sends, stringified without validation —
but `save_analysis`'s `analysis` argument has no declared type (§8), and
Cowork has been observed passing it as an already-JSON-stringified string
rather than a native object. `saveAnalysis` (`src/lib/receipts-store.ts`)
detects that (`normalizeAnalysisJson`: if `analysis` is a string that itself
parses as JSON, store it as-is) so it isn't re-stringified into
double-encoded JSON — a bug that previously made `JSON.parse` yield a string
instead of an object on read, which `src/lib/analysis.ts` silently treated
as unparseable and fell back to all-blank fields. `parseStoredJson` in that
same file unwraps up to three layers defensively (self-healing already-
corrupted rows, not just preventing new ones) before either `parseAnalysis`
or `mergeAnalysis` looks at the result.

`src/lib/analysis.ts` — used only by the review page (§9.3), not by `/mcp`
— reads the parsed object leniently (aliasing `vendor`/`merchant`/`store`,
`total`/`grandTotal`/`amount`,
`reference`/`referenceNumber`/`invoiceNumber`/`receiptNumber`/`receiptNo`,
`date`/`purchaseDate`/`transactionDate`/`receiptDate`,
`dueDate`/`due_date`/`paymentDueDate`/`dueBy`,
`items`/`lineItems`/`line_items`, and per-item
`description`/`amount`/`category` aliases; a numeric-looking `reference` is
coerced to a string rather than dropped, since a value like `"0020012364141"`
is invalid JSON as a bare number literal — leading zeros aren't allowed — so
a model treating it as numeric would otherwise silently lose them) and
writes back a stable shape: `{ vendor, date, dueDate, total, currency,
reference, notes, items: [{ description, amount, category }], reviewedBy,
reviewedAt, ...whatever else was already there }`. `dueDate` is the payment
due date (distinct from `date`, the purchase/transaction date) — captured so
it can flow through to Manager's purchase invoice `Due date` field instead
of requiring a second lookup at posting time. `confidence`/`confidenceReason` — set
by Cowork's own task instructions (`CLAUDE_COWORK_TASK.md`, not part of this
repo's contract) — are read the same lenient way but are only treated as a
"needs human review" signal when `confidence` is `"review"`
(`needsHumanReview` in `src/lib/analysis.ts`). A non-empty
`confidenceReason` on an `"auto"` receipt is just explanatory notes (FX
matching, surcharge arithmetic, etc.) and does not raise the review banner
or the list-page reason line. Both fields are read-only: never part of the
edited/saved shape, preserved only via the `...base` spread. `reference` is
the invoice/receipt number printed on the paper receipt itself (distinct
from the row's own `id`) — worth capturing because Manager's own purchase
invoices have a `Reference` field, and it also makes a better `search_term`
for `attach_receipt_to_purchase_invoice` in the `manager-mcp` fork than
`Description` (more likely to be unique). Keys the page doesn't recognise
are preserved untouched on save.

`processed_at` was added after the table already existed in production, so
`openDb()` checks `PRAGMA table_info(receipts)` and runs `ALTER TABLE ...
ADD COLUMN` on first connect if it's missing, rather than relying on
`CREATE TABLE IF NOT EXISTS` (which doesn't alter existing tables).

MCP OAuth adds three tables in the same database: `oauth_clients` (DCR
registrations), `oauth_auth_codes` (one-time code ids), and
`oauth_refresh_tokens` (rotating refresh `jti`s).

### 6.3 Store operations

`src/lib/receipts-store.ts` exports `saveReceipt`, `listReceipts`, `getReceipt`,
`readReceiptImage`, `saveAnalysis`, `markProcessed`, `setProcessed` and
`deleteReceipt`. `markProcessed` is `setProcessed(id, true)`;
`setProcessed(id, false)` clears `processed_at` back to `NULL` and exists
only for the review UI's manual override (§9.3) — the MCP surface still only
ever sets it, never clears it. `deleteReceipt` removes the row and unlinks
its JPEG (best-effort — a missing file doesn't fail the call) and has no
opinion on whether the receipt is processed; that guard lives in the API
route (§7), not the store.

`saveReceipt` writes the file first and unlinks it if the insert fails, so there
are no orphaned files. `listReceipts` filters on `since`/`until` against
`created_at`, on `analysed_at IS NULL` and on `processed_at IS NULL`, orders by
`created_at DESC`, and limits to 50 by default, clamped to 1–200.

---

## 7. HTTP API

All handlers run on the Node runtime. Errors are `{ error: string }`.

### `POST /api/send`

Session JWT. `multipart/form-data`: `receipt` (required image or PDF file)
and `capturedAt` (optional, §5.3). Rejects an empty or absent file, anything
over **8 MB** (checked against the uploaded file, before PDF conversion),
and non-image/non-PDF content types, all with `400`. A `receipt` whose
content type is `application/pdf` (or, absent a content type, a `.pdf`
filename) is converted server-side to a JPEG of its first page via
`renderPdfFirstPageToJpeg` (`src/lib/pdf-to-image.ts`, §9.2) before storage —
a `400` with the conversion error (e.g. `"Could not read PDF: ..."`) is
returned if that fails, rather than storing an unreadable row. Returns
`{ ok: true, id, createdAt }`.

### `GET` / `PUT` / `POST /api/receipts/:id/image`, `POST /api/receipts/:id/review`, `POST /api/receipts/:id/status`, `DELETE /api/receipts/:id`

**GET `.../image`:** Session JWT (cookie or Bearer) **or** a `?token=` query
param verified by `verifyImageAccessToken` (`purpose: "image-access"`) against
that same receipt id (§8) — either is sufficient, checked in parallel. Backs
the review page (§9.3) and receipts list (§9.1). The token path exists for
`get_receipt`'s `imageUrl`, fetched by an external MCP server, not by Cowork
itself. Streams the stored JPEG (also usable directly as a download link —
the browser names the file from the response, so callers wanting the original
filename set `download=` on the `<a>`, as the review page does). Returns
`404` if the row exists but no file has been attached yet (placeholder from
`create_receipt`).

**PUT / POST `.../image`:** attaches image bytes to an existing receipt
(typically a `create_receipt` placeholder). Auth: session JWT **or** an
`image-upload` JWT (`verifyImageUploadToken`) via `Authorization: Bearer` or
`?token=` — access tokens and upload tokens are not interchangeable. Body is
either raw image bytes with an image `Content-Type`, or `multipart/form-data`
with field `receipt` (same as `/api/send`). Same 8 MB / image-MIME / no-PDF
rules. One-shot: returns `409` if an image is already present. Success:
`{ ok: true, id, createdAt, filename, mimeType, sizeBytes }`.

`POST .../review` takes `{ vendor, date, dueDate,
total, currency, reference, notes, items: [{ description, amount, category }] }`,
requires at least one item, and writes it through `mergeAnalysis` (§6.2) via
the same `saveAnalysis` store function `save_analysis` uses. It deliberately
never calls `markProcessed` — the point of the page is to finalise the split
so Cowork picks the receipt back up as still-unprocessed on its next run and
loads it into Manager itself; Cowork remains the only caller that sets
`processed_at` as part of its normal flow. `POST .../status` takes
`{ processed: boolean }` and calls `setProcessed` directly — a manual
override for the human (undo a premature `mark_processed`, or hand-clear one
Cowork missed) that bypasses that flow entirely. Both POST routes return
`{ ok: true, receipt }`. `DELETE` calls `deleteReceipt` and returns
`{ ok: true }`, but refuses (`409`) if `processed_at` is set — mirrors the
review page, which only shows its Delete button on unprocessed receipts; mark
one unprocessed first (via the status toggle) if it genuinely needs deleting
after Cowork has already touched it.

### `GET /api/health`, `GET /health`

Unauthenticated. `{ ok: true }` and plain-text `ok` respectively; the latter is
the Docker healthcheck target.

### Auth routes

`GET /auth/google` (`?native=1` for the iOS flow), `GET /auth/google/callback`,
and `GET|POST /auth/logout` (303 to `/login`, clearing the cookie).

---

## 8. MCP interface

`POST /mcp` speaks JSON-RPC 2.0 over plain HTTP POST — no SSE, no streaming —
which is sufficient for Cowork's remote-connector support and keeps the server
stateless. Protocol version defaults to `2025-03-26`; server identity is
`receipts` v`0.1.0`. Responses carry a fixed `mcp-session-id: receipts`.
`initialize`, `tools/list`, `tools/call` and `ping` are handled, arrays are
treated as batches, notifications return `202`, and unknown methods return
`-32601`. `GET` returns `405`. Unauthenticated calls return `401` with a
`WWW-Authenticate` resource-metadata pointer so Claude can start OAuth.

Six tools:

- **`list_receipts`** — optional `since`, `until`, `unanalysed`, `unprocessed`,
  `limit` (1–200, default 50). Returns the matching records as JSON text.
- **`get_receipt`** — required `id`. Returns the record as JSON text *and* the
  JPEG as base64 image content, so the model can read the receipt in one call.
  The JSON also carries `imageUrl`: `{appOrigin}/api/receipts/:id/image?token=…`,
  a signed, unauthenticated, 10-minute-TTL link to the same JPEG
  (`src/lib/auth/image-token.ts`, same `SESSION_SECRET`/`jose` HS256 pattern
  as session and OAuth-state tokens, `purpose: "image-access"` scoped to that
  one receipt id). Exists because Cowork can *view* the image content block
  but can't read its base64 back out as text to hand to an unrelated MCP
  server (e.g. `manager-mcp`'s `attach_receipt_to_purchase_invoice`), and has
  no filesystem to stage a file on either — any caller holding the URL,
  including one with no knowledge of this app's auth model, can fetch the
  bytes with a plain `GET`. `GET /api/receipts/:id/image` (§7) accepts this
  token as an alternative to session auth, scoped to that one id; the review
  page keeps using the session path, unchanged. `imageUrl` is additive — the
  image content block remains for Cowork's own analysis step.
- **`create_receipt`** — create a placeholder row (`size_bytes = 0`, no file on
  disk) and return credentials for a follow-up HTTP upload. Optional
  `filename`, `capturedAt`, `mimeType` (default `image/jpeg`).
  `submitted_by` is the MCP OAuth email. Response includes the receipt record
  plus `uploadToken` (JWT, `purpose: "image-upload"`, 30 minutes, scoped to
  that id), `uploadUrl` (`{appOrigin}/api/receipts/:id/image`), and a
  `curlExample`. Cowork then runs something like
  `curl -X PUT -H "Authorization: Bearer <uploadToken>" -H "Content-Type: image/jpeg" --data-binary @"/local/path.jpg" "<uploadUrl>"`.
  No long-lived API key is stored in Cowork — each create mints a fresh upload
  token. Upload tokens cannot GET the image; access tokens cannot upload.
- **`save_receipt`** — store a new receipt image in one MCP call. Requires
  exactly one of `imageUrl` (HTTPS URL the server GETs) or `imageBase64` (plus
  optional `mimeType`, default `image/jpeg`). Optional `filename` and
  `capturedAt`. `submitted_by` from the MCP OAuth email. URL fetch
  (`src/lib/fetch-receipt-image.ts`) is SSRF-guarded: HTTPS only, no URL
  credentials, DNS-resolved addresses must be public (blocks
  loopback/private/link-local/metadata), max 3 redirects, 10s timeout, 8 MB
  body cap, image MIME only. PDFs are rejected. Prefer `create_receipt` when
  Cowork has a local file path it can curl.
- **`save_analysis`** — required `id` and `analysis` (any JSON). Persists it and
  returns the updated record. Include `dueDate` (ISO-8601 payment due date,
  distinct from `date`) whenever the receipt/invoice states one — it's part
  of the stable shape `src/lib/analysis.ts` reads back (§6.2) and is meant to
  carry through to Manager's purchase invoice `Due date` field.
- **`mark_processed`** — required `id`. Sets `processed_at` and returns the
  updated record; does not delete anything. Intended for use once a receipt
  has been recorded downstream (e.g. in an accounting system).

Add it in Cowork as a custom connector at `https://<host>/mcp`. Leave OAuth
Client ID and Client Secret empty. After Add, click **Connect**, sign in with
Google if needed, and Allow on the consent screen.

---

## 9. Web application

The browser no longer captures anything. An OpenCV.js pipeline in a web worker
was tried and abandoned: it failed to find receipt edges reliably against busy
backgrounds and returned uncropped frames often enough to be useless, and
maintaining a custom OpenCV build for a second-class path was not worth it
against Vision on-device. All of it — `ReceiptScanner`, `crop-worker.js`,
`crop-client.ts`, `compress-image.ts` and the build scripts — was deleted rather
than left to rot.

What remains is a thin shell: `/login` offers Google sign-in, and `/` shows
`ReceiptCapture`, which points the user at the iOS app with a `receipts://` deep
link, a sign-out button, and a **Review receipts** button to `/receipts`. On a
desktop browser only (`isMobileRequest`, `src/lib/is-mobile-request.ts` — a
`User-Agent` sniff for `Mobi|Android|iPhone|iPad|iPod`) it also shows an **Or
upload from this computer** link to `/upload` (§9.2), and `/receipts` shows a
matching **Upload** button in its header; both are server-rendered away
entirely on a mobile UA rather than hidden with CSS. Uploading a file makes
sense at a desk with a PDF invoice or a saved image open, not on the phone
that already has the native capture flow — and since the iOS app is pure
SwiftUI with no `WKWebView`, a mobile UA here is always a phone browser, never
the app. `/upload` itself has no server-side guard, so a direct link still
works from a phone if someone lands there anyway. The PWA manifest and
generated `/icon` and `/apple-icon` routes (teal `#0d6e6e`, letter `R`)
survive so the site can still be installed to the Home Screen.

### 9.1 Receipts list — `/receipts`

Session-cookie gated. Server component (`src/app/receipts/page.tsx`) reading
`listReceipts({ limit: 200 })` directly from the store — no MCP round trip.
Three tabs via `?filter=`: **Needs review** (default; `processed_at IS NULL`
— the unprocessed queue, which also includes `"auto"` receipts waiting for
Cowork to post), **All**, and **Processed**. Each row is a thumbnail
(`GET /api/receipts/:id/image`), filename, upload time, `submitted_by`, and a
status pill — *Not yet analysed*, *Analysed*, *Needs review*, or *Processed*
— derived from `analysed_at`/`processed_at` plus `needsHumanReview` (§6.2),
no separate status column. An unprocessed row shows `confidenceReason` under
the pill only when `needsHumanReview` is true, truncated to one line. The
row links to `/review/:id` (§9.3). This is a read model only; nothing here
writes to the database. 200 is `listReceipts`'s clamp ceiling (§6.3) — there
is no pagination past that.

### 9.2 Upload — `/upload`

Session-cookie gated; linked from `/` and from `/receipts`, but only on a
desktop User-Agent (above). `ReceiptUpload`
(`src/components/ReceiptUpload.tsx`) is a client-side drag-and-drop zone
(click to browse falls back to a hidden `<input type="file" accept="image/*,
application/pdf" multiple>`) that posts each dropped/selected file to the
existing `POST /api/send` (§7) — the same endpoint the iOS app's fallback web
flow would use — one request per file, filtering out anything that's neither
image nor PDF and anything over 8 MB before sending so the server round trip
isn't wasted on an obvious rejection. Each row in the queue shows the
filename and, once uploaded, a **Review** link to `/review/:id` (§9.3); a
failed upload (including a PDF `/api/send` couldn't convert) shows the
server's error message inline rather than blocking the rest of the queue.

A PDF is converted server-side to a JPEG of its first page — see
`renderPdfFirstPageToJpeg` (`src/lib/pdf-to-image.ts`) via `/api/send` (§7) —
using `pdfjs-dist` (rendering) and `@napi-rs/canvas` (a native, prebuilt-binary
canvas implementation for Node, including `linux-musl` for the Alpine
Docker image) rather than shelling out to poppler/ImageMagick, so no system
package was added to the Dockerfile. Both are listed in
`next.config.ts`'s `serverExternalPackages` — their native binary can't be
bundled by Turbopack/webpack, so it's `require`d from `node_modules` at
runtime instead, same as any other native addon; `output: "standalone"`
still traces and copies it (binary included) into the deployed bundle.
`next.config.ts` also force-includes `node_modules/pdfjs-dist/legacy/build/**`
via `outputFileTracingIncludes` for the `/api/send` route: pdfjs's Node
fallback ("fake worker", used since no real `Worker`/`worker_threads` set-up
is wired here) `require`s `pdf.worker.mjs` by a path it computes at runtime
rather than a static import, so standalone tracing doesn't discover it on
its own — confirmed by building, then actually running `node server.js`
against the traced `.next/standalone` output (not just `next dev`, which
doesn't go through tracing and so didn't catch this): it failed with
`Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'` until this
was added. Only the first page is rendered — a receipt/invoice PDF is
single-page in practice, and the data model is one JPEG per receipt row
regardless. This
conversion is local to `/api/send`; the MCP tools (`create_receipt`,
`save_receipt`, §8) still reject `application/pdf` outright — Cowork is
expected to hand over an image the same way it always has.

### 9.3 Review page — `/review/[id]`

For receipts Cowork flags rather than auto-processing (ambiguous category
splits, low-confidence reads, anything its rules say to leave for a human —
Cowork's own review criteria live in its Cowork configuration, not in this
repo). Session-cookie gated like the rest of the app; page routes with
no session redirect to `/login?next=/review/<id>` and land back here after
sign-in. Cowork gives the user a plain link,
`{appOrigin}/review/<receipt id>` (`src/lib/app-origin.ts`); the page also
links back to `/receipts`, and any receipt in that list can be opened the
same way, review-flagged by Cowork or not.

`src/app/review/[id]/page.tsx` loads the receipt server-side with
`getReceipt` and parses `analysis_json` with `parseAnalysis` (§6.2), also
passing `hasAnalysis: receipt.analysisJson !== null` — when false,
`ReceiptReview` shows a banner making clear the fields below are blank
because nothing was ever saved, not because extraction found nothing
(the two used to be visually indistinguishable, which is what made the
double-encoding bug in §6.2 confusing to diagnose). A banner ("Why this
needs review: ...") renders only when `needsHumanReview` is true *and*
`confidenceReason` is non-empty — not for explanatory notes on `"auto"`
receipts. `ReceiptReview`
(`src/components/ReceiptReview.tsx`) is the client form: the
receipt image (`GET /api/receipts/:id/image`, tap to enlarge), a
**Download image** link (`<a download>` on that same endpoint, so it saves
under the original `filename` rather than the id), a **Mark
processed**/**Mark unprocessed** toggle (`POST /api/receipts/:id/status`,
§7 — local state updates immediately from the response), a **Delete** link
(only rendered while unprocessed; `window.confirm` before calling
`DELETE /api/receipts/:id` and redirecting to `/receipts` on success),
vendor/date/dueDate/total/currency/reference, an editable item table (description
and amount only — category isn't a human-editable field here; matching a
line to a Manager expense account is Cowork's job, per §6.2, not something
this page asks the reviewer to pick), and a running items-total that flags
in red when it doesn't reconcile with the declared total. Each item's
`category` still round-trips unedited through Save (it's part of `Row`'s
state, just not rendered), so a human correcting a description or amount
split doesn't blank out the category Cowork already assigned. Save posts to
`POST /api/receipts/:id/review` (§7), which
only rewrites `analysis_json` and leaves `processed_at` alone — the receipt
stays (or becomes) unprocessed. There is no Manager API integration and Save
never marks a receipt processed itself: it hands the corrected split back to
Cowork, which is expected to pick the receipt up again via
`list_receipts(unprocessed: true)` on its next run, load the now-finalised
split into Manager, and call `mark_processed` itself. The status toggle is a
separate, explicit manual override for cases that flow doesn't cover — undoing
a receipt Cowork (or a previous toggle) marked processed too early, or
hand-clearing one it missed.

---

## 10. Configuration and deployment

### 10.1 Server environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ALLOWED_USERS` | Yes | empty (denies all) | Comma-separated Google emails |
| `GOOGLE_CLIENT_ID` | Yes | — | OAuth client |
| `GOOGLE_CLIENT_SECRET` | Yes | — | OAuth client |
| `GOOGLE_REDIRECT_URI` | Yes | — | Public callback URL; also decides cookie `secure` and app origin |
| `SESSION_SECRET` | Yes | — | HS256 signing key |
| `DATA_DIR` | No | `{cwd}/data` | DB and images |
| `NATIVE_APP_REDIRECT` | No | `receipts://auth` | iOS OAuth return |
| `NEXT_BUILD_CPUS` | No | unset | Caps build parallelism |

### 10.2 iOS build settings

`PRODUCT_BUNDLE_IDENTIFIER` (Xcode target build setting, pattern
`<domain-reverse>.receipts`, e.g. `au.com.acme.receipts`) is the single source of
truth for the bundle id — nothing else hardcodes it. `Info.plist`'s
`CFBundleURLName` and `BGTaskSchedulerPermittedIdentifiers` entry reference it
via `$(PRODUCT_BUNDLE_IDENTIFIER)`, and `ReceiptsApp.swift`'s
`retryTaskIdentifier` derives it at runtime from `Bundle.main.bundleIdentifier`
rather than a literal, so changing the one Xcode setting is enough to rebrand
the app (a fork still needs its own `DEVELOPMENT_TEAM` and, for push/App Store
distribution, its own App Store Connect record).

Display name Receipts, marketing version 1.0, deployment target iOS 17.0,
iPhone-only, portrait-only, category finance, team `HDPPA6WPMT`, automatic
signing. `SWIFT_STRICT_CONCURRENCY = minimal` — the UIKit and AVFoundation
delegate callbacks in `ScanCameraView` cannot satisfy Swift 6 strict checking
without `@unchecked Sendable` scattered through them, and `minimal` was judged
the honest trade rather than annotating away real warnings.

`Info.plist` declares `CFBundleIconName = AppIcon`, the `receipts` URL scheme,
`ITSAppUsesNonExemptEncryption = false`, and the background-refresh keys from
§5.4. The icon set covers 40 through 1024 px for iPhone and marketing;
`CFBundleIconName` and the asset catalog are both required or App Store
Connect rejects the upload. There is no build-time server URL — see §3.5.

### 10.3 Deployment

`./deploy-docker.sh [env]` builds the image and restarts the
`receipt-submission` container on port **55666** with `--restart unless-stopped`.
Secrets are read from `.env.$APP_ENV` at run time and never baked in
(`.dockerignore` excludes `.env*`); `./data` is bind-mounted to `/app/data`.

The image is `node:22-alpine` with Next.js standalone output, running as
uid 1001, healthchecked against `/health` every 60 s. The build pins
`NEXT_BUILD_CPUS=1` and a 1536 MB heap because Colima commonly defaults to 2 GB
and the build is otherwise OOM-killed.

CI is `.github/workflows/ios.yml` only: an unsigned simulator build of the iOS
app on `macos-15`, triggered on changes under `ios/**`. There is no web CI.

TestFlight distribution is Xcode Cloud, which — unlike a local build — has no
concept of an uncommitted override: it always archives exactly what's on the
watched branch. Since the tracked `PRODUCT_BUNDLE_IDENTIFIER` is the public
placeholder `au.com.acme.receipts` (§10.2), `ios/ci_scripts/ci_post_clone.sh`
rewrites it in the cloned `project.pbxproj` right after checkout, before Xcode
reads build settings, using a **Plain** environment variable named
`RECEIPTS_BUNDLE_ID` configured on the Xcode Cloud workflow in App Store
Connect (Xcode Cloud → workflow → Environment → Environment Variables). The
script fails the build loudly if that variable is unset rather than silently
archiving under the placeholder id.

The same script optionally injects a second, also Plain, variable,
`RECEIPTS_DEFAULT_SERVER_URL`, as an `Info.plist` key of the same name — see
§3.5. Unlike `RECEIPTS_BUNDLE_ID` this one isn't required: if it's unset the
build proceeds and the app just shows its normal first-run setup screen.
Neither variable needs Secret — a bundle id and a server hostname are already
public, unlike a real credential (§3).

---

## 11. Security posture

Known and accepted, in rough order of significance:

- **Sessions live 400 days** and cannot be revoked individually. Removing the
  address from `ALLOWED_USERS` is the only revocation, checked per request.
- **Receipt images are unencrypted at rest** in `$DATA_DIR`, protected only by
  filesystem permissions.
- **Held receipts sit unencrypted** in the app's Documents directory, covered by
  iOS data protection and device passcode only.
- **TLS is the reverse proxy's job.** The container serves plain HTTP on 55666 and
  must not be exposed directly.

---

## 12. Known gaps

- Capture time is not a first-class column (§6.2), so listing and filtering are
  by upload time. A receipt held for a week sorts by when it arrived.
- No pruning: `attempts` and `lastError` accumulate on held receipts and nothing
  alerts if an entry is stuck indefinitely beyond the on-device count.
- `createSession()` and `deleteSession()` in `src/lib/auth/session.ts` are dead
  code; the OAuth callback and logout route manipulate cookies directly.
- No automated tests. Correctness of the capture-time stamp and the multipart
  encoding was established by one-off scripts, not a suite.
