# Feature Specification: Self-Hosted Accounting Stack

**Feature Branch**: `001-accounting-stack`

**Created**: 2026-08-26

## Overview

A small business's books, its receipt archive, and its email all hold pieces of
the same picture, and reconciling them by hand is the tedium this stack exists to
remove. Manager.io holds the ledger. Receipts holds photographed and relayed
receipts. Two MCP servers expose the ledger and the mailbox to an AI agent
(Claude Cowork) so that filing a receipt, matching it to a bank transaction, and
attaching it to a purchase invoice can happen without a human moving files
between four applications.

This repository is the **assembly**, not the components. It owns how four
services are built, configured, wired, secured, and started together. Three of
the four are specified in their own right elsewhere; this spec covers the seams
between them, which nothing else does.

**Deliberately out of scope**: TLS, public hostnames, and reverse proxying. A
separate `home-gateway` project owns the public surface and reaches these
services over host-published plain-HTTP ports. That boundary is the single most
load-bearing assumption in this document.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bring the whole stack up from a clean checkout (Priority: P1)

An operator with a fresh clone, real credentials in hand, runs one command and
ends up with four healthy services on known ports.

**Why this priority**: If the stack cannot be stood up reproducibly, nothing else
in this repository matters. This is the repository's primary deliverable.

**Independent Test**: On a machine with Docker and the secrets files populated,
run `./deploy.sh` and confirm all four containers reach a running state and the
two health-checked services respond.

**Acceptance Scenarios**:

1. **Given** all required secrets files exist, **When** the operator runs `./deploy.sh`, **Then** images are built (using layer cache), containers start, and Manager, manager-mcp, receipts, and gmail-relay are all running.
2. **Given** any of `secrets/manager-mcp.env`, `secrets/receipts.env`, or `secrets/gmail-relay.env` is missing, **When** `./deploy.sh` runs, **Then** it aborts **before** touching Docker, naming each missing file and the `cp`-from-example remedy.
3. **Given** the stack is starting, **When** deploy waits on health, **Then** it polls manager-mcp and receipts for up to 60 seconds and reports each as healthy or timed out without aborting the deployment.
4. **Given** a successful deployment, **When** it completes, **Then** the operator is shown each service's local port and the common follow-up commands.
5. **Given** a source or submodule change with no image-tag change, **When** `./deploy.sh` runs, **Then** the affected image is rebuilt anyway — an image existing locally is never taken as evidence it is current.

---

### User Story 2 - Expose the books and the mailbox to an AI agent, safely (Priority: P1)

The operator's agent needs to query the ledger and relay receipts from email.
Both MCP servers are reachable from the open internet, so both must admit that
one agent and nothing else.

**Why this priority**: This is the stack's reason for existing, and it is the
part with real exposure — an internet-reachable service holding both accounting
data and full mailbox access.

**Independent Test**: Complete the MCP OAuth flow against each server with a
non-allowlisted Google account and confirm both refuse.

**Acceptance Scenarios**:

1. **Given** `manager-mcp` and `gmail-relay` both run in HTTP transport, **When** a client connects, **Then** each independently enforces Google OAuth **plus** its own email allowlist, refusing valid Google logins outside that list.
2. **Given** the stack is deployed, **When** OAuth clients are provisioned, **Then** five distinct Google OAuth clients exist — Manager UI (via home-gateway's oauth2-proxy), manager-mcp, receipts, gmail-relay's MCP-access client, and gmail-relay's Gmail+Drive API client — and none is reused across roles.
3. **Given** an agent holds an allowlisted identity, **When** it queries manager-mcp, **Then** it can read the books, and can write only within the explicitly configured `MANAGER_MCP_WRITE_SCOPES` / `MANAGER_MCP_DELETE_SCOPES` (both empty by default).

---

### User Story 3 - Keep bank transactions flowing in without a UI click (Priority: P2)

Manager imports bank transactions only when someone clicks a button in its UI —
"Sync All Linked" in the Aussie Bank Feeds modal, or the older built-in "Check for
New Transactions" control. Nobody wants to click it hourly.

**Why this priority**: Genuine ongoing automation value, but the stack is usable
without it — the button still exists.

**Independent Test**: Set the sync interval, wait one period, and confirm from
manager-mcp's logs that a sync ran and new transactions appeared in Manager.

**Acceptance Scenarios**:

1. **Given** `MANAGER_MCP_BANK_FEED_SYNC_INTERVAL_SECONDS=3600`, **When** manager-mcp runs, **Then** it triggers a bank-feed import hourly from inside its own process — an operator job, not an MCP tool and not an external scheduled task.
2. **Given** `BASIQ_USERNAME`/`BASIQ_PASSWORD` are set, **When** the sync runs, **Then** it takes the Aussie Bank Feeds path: authenticating against that service's own AWS Cognito pool (unrelated to Manager's login), reading new transactions from Basiq, and posting them into Manager's `/api4/receipt-batch` (credits) and `/api4/payment-batch` (debits).
3. **Given** those Basiq credentials are absent, **When** the sync runs, **Then** it falls back to Manager's built-in `/check-for-new-transactions` UI action, for a business that never set up Aussie Bank Feeds.
4. **Given** the variable is unset or `0`, **When** manager-mcp runs, **Then** no sync is scheduled — the stdio/development default.
5. **Given** either path runs, **When** it authenticates to Manager, **Then** it uses HTTP Basic Auth as the dedicated `mcp` user, because `MANAGER_API_KEY` covers only `/api2` — neither UI actions nor `/api4`.
6. **Given** the built-in UI action is invoked, **When** its path is built, **Then** it is the root-level `/check-for-new-transactions?{FileID}`; the nested `/bank-and-cash-accounts/check-for-new-transactions` returns the list page and imports nothing.

---

### User Story 4 - Attach a receipt to a purchase invoice (Priority: P2)

Having filed a receipt, the agent attaches the image to the matching purchase
invoice in the books, closing the loop between the archive and the ledger.

**Why this priority**: The payoff that makes the receipt archive worth keeping,
but it depends on Stories 1 and 2 and on a fragile undocumented interface.

**Independent Test**: Call `attach_receipt_to_purchase_invoice` against a real
Manager instance and confirm the attachment appears on the invoice.

**Acceptance Scenarios**:

1. **Given** `MANAGER_UI_USERNAME`/`MANAGER_UI_PASSWORD` are set for a Manager user granted Purchase Invoices View/Create/Update, **When** the agent attaches a receipt, **Then** the attachment appears on the invoice.
2. **Given** those credentials are unset, **When** the server starts, **Then** it starts normally and only attachment uploads fail — a missing optional capability must not take down the server.
3. **Given** the `mcp` user exists but lacks the Settings → User Permissions grants, **When** an attach is attempted, **Then** it fails *authorization* while Basic Auth still succeeds — a distinct failure from a bad password, and one the logs must make distinguishable.

---

### User Story 5 - Operate and diagnose a running stack (Priority: P3)

Something is wrong. The operator needs status, logs, a restart, or a forced
rebuild without remembering compose invocations.

**Why this priority**: Convenience over capability — every one of these is
achievable with raw `docker compose`.

**Independent Test**: Run each `deploy.sh` subcommand and confirm it performs the
documented action.

**Acceptance Scenarios**:

1. **Given** a deployed stack, **When** the operator runs `status`, `stop`, `restart`, or `logs [service]`, **Then** the corresponding compose operation runs.
2. **Given** a suspected stale image, **When** the operator runs `rebuild` or `rebuild nocache`, **Then** images are rebuilt (with `--pull`, optionally `--no-cache`) and containers force-recreated.
3. **Given** an unrecognised subcommand, **When** it is run, **Then** deploy exits non-zero with usage text.
4. **Given** a repeated no-op deployment, **When** `./deploy.sh` runs twice with no source change, **Then** containers are **not** needlessly recreated — BuildKit provenance attestations are disabled so an all-cached build yields an identical digest.

### Edge Cases

- **Missing secrets**: caught before Docker is contacted, so the failure is fast and legible rather than a container crash-loop.
- **Docker not running**: detected explicitly, with a Colima-aware hint on macOS; Colima is auto-started when installed and is a no-op on the Linux deployment server.
- **Health-check timeout**: a service failing to become healthy within ~60s produces a warning naming the log command, not an aborted deployment — partial availability beats no feedback.
- **Port collision**: host ports (55666-55669) are hardcoded, not env-overridable, because they are a fixed contract with `home-gateway`'s upstream configuration. Changing one here without changing it there breaks routing silently.
- **Container-to-container addressing**: manager-mcp reaches Manager at `http://manager:8080/api2` — the internal Docker DNS name and port, never the published `55667`, since nothing in Manager's network namespace listens on the host port.
- **Loopback-only binding**: ports bind `0.0.0.0`. Switching to `127.0.0.1` may break `home-gateway`'s `host.docker.internal` reachability under Colima's Lima-VM networking, which does not replicate Docker Desktop's macOS behaviour.
- **Build-time network dependency**: the `manager` service builds from a git submodule and downloads Manager from GitHub, so the build host needs outbound GitHub access — unlike a plain `image:` pull. An air-gapped server must pull a pre-built image from a registry instead.
- **Timezone**: manager-mcp sets `TZ=Australia/Melbourne`; containers otherwise log in UTC, mismatching the business's local time.
- **Upstream image staleness**: `chrborg/manager.io:latest`'s published download URL was stale, pinned to an old Manager version — hence the fork.
- **arm64 hosts**: Manager needs native Chromium for PDF generation; PuppeteerSharp would otherwise fetch an x86_64 Chrome build that cannot execute on arm64.

## Requirements *(mandatory)*

### Functional Requirements

**Composition**

- **FR-001**: The stack MUST define exactly four services: `manager`, `manager-mcp`, `receipts`, and `gmail-relay`, under compose project name `accounting`.
- **FR-002**: `manager` MUST build from the pinned `docker-manager.io` submodule fork rather than pulling `chrborg/manager.io:latest`.
- **FR-003**: `manager-mcp` and `receipts` MUST build from their sibling package directories with no vendoring of source.
- **FR-004**: Services MUST publish fixed host ports: Manager 55667, receipts 55666, manager-mcp 55668, gmail-relay 55669.
- **FR-005**: All services MUST use `restart: unless-stopped`.
- **FR-006**: `manager-mcp` MUST declare a dependency on `manager`.
- **FR-007**: Persistent state MUST live in host bind mounts — `./data/manager` → `/data`, `./data/receipts` → `/app/data` — overridable via `MANAGER_DATA_DIR` / `RECEIPTS_DATA_DIR`.
- **FR-008**: gmail-relay's Google credentials MUST be mounted read-only at `/secrets`, and its scratch space MUST be a named volume, not a bind mount.

**Configuration and secrets**

- **FR-009**: Secrets MUST live in `secrets/*.env`, be gitignored, be mode 0600, and never be committed; each MUST ship a committed `.example` counterpart.
- **FR-010**: Non-secret configuration MUST be set inline in `compose.yaml`; only credentials belong in env files.
- **FR-011**: Google API credentials MUST live at `secrets/gmail/`, gitignored entirely.
- **FR-012**: `secrets/manager.env` MUST exist as a layout placeholder only — the Manager image documents no env-based secrets, and its API token is generated inside the Manager UI.

**Deployment**

- **FR-013**: `deploy.sh` MUST verify all required secrets files exist before invoking Docker.
- **FR-014**: `deploy.sh` MUST verify the Docker daemon and Compose plugin are available, starting Colima if installed.
- **FR-015**: `deploy.sh` MUST build on every `up` rather than only when an image is absent.
- **FR-016**: `deploy.sh` MUST disable BuildKit default attestations so an all-cached rebuild does not force container recreation.
- **FR-017**: `deploy.sh` MUST support `up`, `rebuild [nocache]`, `stop`, `restart`, `status`, and `logs [service]`, rejecting anything else.
- **FR-018**: `deploy.sh` MUST poll health endpoints for manager-mcp and receipts, warning rather than failing on timeout.

**Authentication**

- **FR-019**: Both MCP servers MUST enforce Google OAuth plus an independent email allowlist.
- **FR-020**: The five OAuth clients MUST be distinct, each scoped to one role.
- **FR-021**: manager-mcp MUST default to no write and no delete scopes.
- **FR-022**: Manager UI action and `/api4` endpoints MUST authenticate via HTTP Basic Auth as a dedicated restricted Manager user, since `MANAGER_API_KEY` covers only `/api2`.
- **FR-023**: That Manager user MUST be a Restricted user granted only Purchase Invoices (View/Create/Update) and Bank and Cash Accounts (View), because its credentials live in a plaintext env file.

**Bank-feed automation**

- **FR-024**: The stack MUST trigger a bank-feed import on the interval given by `MANAGER_MCP_BANK_FEED_SYNC_INTERVAL_SECONDS`, running inside manager-mcp's own process as an operator job rather than as an MCP tool or an external scheduler.
- **FR-025**: The sync MUST use the Aussie Bank Feeds / Basiq path when `BASIQ_USERNAME`/`BASIQ_PASSWORD` are set, and MUST otherwise fall back to Manager's built-in `/check-for-new-transactions` UI action.
- **FR-026**: An unset or `0` interval MUST disable the sync entirely.

**Boundaries**

- **FR-027**: This project MUST NOT own TLS, public hostnames, or reverse-proxy configuration.
- **FR-028**: Services MUST publish plain HTTP on host ports reachable by `home-gateway` via `host.docker.internal`.

### Key Entities

- **Manager.io server**: the accounting system of record. All ledger state lives in its `/data` volume (`Businesses/`, `Blobs/`).
- **manager-mcp**: MCP interface to the books — read tools, scope-gated writes, receipt attachment, and the hourly bank-feed trigger. Specified separately at `manager-mcp/specs/001-manager-readonly-mcp/`.
- **receipt-submission**: the receipt archive — mobile capture, JPEG storage, SQLite metadata, and its own MCP surface. Specified at `specs/003-receipt-submission/`.
- **gmail-relay**: relays email attachments and Drive files into the archive without their bytes entering an LLM's context. Specified at `specs/002-gmail-relay-mcp/`.
- **Secrets directory**: the deployment's trust root; every credential the stack holds.
- **Data directory**: the stack's durable state; the only thing whose loss is unrecoverable.
- **home-gateway**: external project owning TLS, public hostnames, and the oauth2-proxy in front of the Manager UI. Consumes this stack's fixed host ports.
- **Claude Cowork**: the sole intended client of both MCP servers; scheduled tasks drive the workflows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh clone with populated secrets reaches four running services with one command and no manual compose invocations.
- **SC-002**: A missing or malformed secret is reported by name before any container starts.
- **SC-003**: No Google account outside the configured allowlists can reach either MCP server, despite valid Google logins.
- **SC-004**: A no-op redeployment does not recreate containers, so routine deploys cause no avoidable downtime.
- **SC-005**: Bank transactions import hourly with no human interaction.
- **SC-006**: Ledger and receipt data survive container recreation and image rebuilds.
- **SC-007**: No credential is ever committed to the repository.
- **SC-008**: A change to a component's source is reflected in the running stack after `./deploy.sh`, with no manual image-tag bump.

## Assumptions

- **Single operator, single business.** Authorisation throughout is a short email allowlist. No multi-tenancy, no role model.
- **`home-gateway` exists and runs on the same host.** It reaches this stack via `host.docker.internal` and terminates all TLS. Its `MANAGER_UPSTREAM` / `MANAGER_MCP_UPSTREAM` / `RECEIPTS_UPSTREAM` must match this stack's hardcoded ports.
- **Docker Compose v2** with BuildKit, on Colima (macOS development) or a system daemon (Linux deployment).
- **The build host can reach GitHub** at build time, for the Manager submodule build.
- **Google Cloud OAuth clients are provisioned by a human.** No automation can create them; this is a documented manual prerequisite.
- **`secrets/gmail/credentials.json` is minted out of band** by `gmail-relay/scripts/gmail_oauth_init.py`, once, on a machine with a browser.
- **Manager's undocumented UI action endpoints remain stable.** Attachment upload and bank-feed sync depend on interfaces Manager does not document and may change on upgrade.
- **The components carry their own specs.** manager-mcp and receipt-submission are specified in their own trees; duplicating them here would guarantee drift.

## Known Discrepancies

- **DISC-001**: `README.md` cites a spec by section (§2, §5, §6, §8, §9, §10, §11, §12) that does not exist in this repository. `compose.yaml:3-4` locates it at `../lilith-accounting/docs/ACCOUNTING_PLATFORM_DEPLOYMENT_SPEC.md` — outside the repo, so those references are unresolvable to anyone cloning this alone. The same section numbers appear in `secrets/*.example`.
- **DISC-002**: `deploy.sh:141` claims gmail-relay has no health endpoint; it has had `GET /health` since `server.py:82`. Deploy could poll it as it does the other two.
- **DISC-003**: `secrets/gmail-relay.env.example` refers to `deployment/secrets/gmail/gcp-oauth.keys.json`; the real path has no `deployment/` prefix.
- **DISC-004**: `secrets/manager-mcp.env.example` carries `BASIQ_USERNAME`/`BASIQ_PASSWORD`, and they select the *primary* bank-feed mechanism (`manager-mcp/src/manager_mcp/bank_feeds.py`) — yet the root `README.md` describes the hourly sync only as the `/check-for-new-transactions` fallback and never mentions Basiq or Aussie Bank Feeds. The stack's main path for importing transactions is undocumented at this level.
- **DISC-009**: The Aussie Bank Feeds path depends on interfaces reverse-engineered from Manager's own frontend on 2026-08-31 — a third-party Cognito pool, Basiq's API (which requires browser-like headers to evade Cloudflare bot detection), and Manager's undocumented `/api4` batch endpoints. Nothing about this contract is published or version-guaranteed.
- **DISC-005**: The `manager-mcp` Dockerfile was lint- and unit-tested but never build-verified in a running container (per README) — Docker was unreachable when it was authored.
- **DISC-006**: `manager-mcp`'s own spec is titled "Read-Only MCP Server", but the implementation now has scoped writes, receipt attachment, and bank-feed sync. That spec has drifted from what ships.
- **DISC-007**: No backup or restore mechanism exists for `data/`, despite it holding the only unrecoverable state. README lists this as open.
- **DISC-008**: The Manager image's internal `/data` layout is documented as still unverified against a running container; the Desktop layout is assumed, not confirmed.
