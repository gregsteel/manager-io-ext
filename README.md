# manager-io-ext

## Architecture

Three scheduled Claude Cowork tasks drive the accounting stack:
- `docker-manager.io` is a dockerised deployment of Manager.io server
- `manager-mcp` is an MCP server that wraps Manager.io and performs supporting functions such as polling for bank transactions.  It is forked from [flumpiey/manager-mcp](https://github.com/flumpiey/manager-mcp)
- `gmail-relay` is an MCP server that connects with GMail and supports attachments (which the OOB connectors for some LLM harnesses don't)
- `receipts-submission` provides a simple app for capturing receipts via mobile, wrapped with an MCP server that allows an LLM to analyse it

This project does not own TLS, public hostnames, or nginx. This stack publishes plain HTTP ports on the host reachable via `host.docker.internal`.

## Setup

Secrets and bind-mount data live at the repo root, alongside `compose.yaml`
and `deploy.sh`:

```
secrets/             # real *.env files — gitignored, mode 0600, never committed
  manager.env.example
  manager-mcp.env.example
  receipts.env.example
  gmail-relay.env.example
  gmail/             # gitignored entirely — credentials.json + gcp-oauth.keys.json
                     # for Gmail + Drive API access via gmail.modify (read
                     # messages/attachments, mark a message read after
                     # relaying its attachment) and drive (download a file
                     # and delete it after a successful Receipts relay),
                     # mounted read-only. Minted once via
                     # `gmail-relay/scripts/gmail_oauth_init.py` (from the
                     # repo root) — unrelated to the Google OAuth client
                     # below, which instead gates who may connect to
                     # gmail-relay itself.
data/                # bind mounts — gitignored
  manager/           # -> /data in the manager container
  receipts/          # -> /app/data in the receipts container
```

```sh
cp secrets/manager-mcp.env.example secrets/manager-mcp.env
cp secrets/receipts.env.example secrets/receipts.env
cp secrets/gmail-relay.env.example secrets/gmail-relay.env
chmod 600 secrets/*.env
# fill in real values — see the spec's §8 for what each secret is and where it comes from
```

`manager-mcp.env` needs `MANAGER_UI_USERNAME`/`MANAGER_UI_PASSWORD` in addition
to `MANAGER_API_KEY` if you want attachment uploads to work — see "The Manager
`mcp` user" below for what that account needs and why.

### The Manager `mcp` user (for attachment uploads and bank-feed sync)

`manager-mcp`'s `attach_receipt_to_purchase_invoice` tool (see
`../manager-mcp/src/manager_mcp/attachments_api.py`) attaches receipts by
calling two of Manager's own *undocumented* internal action endpoints
directly — there's no documented `/api2` endpoint for this. Those endpoints
are part of Manager's web UI/action layer, not `/api2`, and **`MANAGER_API_KEY`
does not authenticate them** — that key only covers `/api2`. The hourly
bank-feed sync (`/check-for-new-transactions`)
is the same: a UI action that wants HTTP Basic Auth, not `X-API-KEY` and
not the old `/api/…` namespace (that one 401s before routing). Nested
`/bank-and-cash-accounts/check-for-new-transactions` only renders the list
page and does not import. Manager
accepts Basic Auth using a real Manager user account as an alternative to a
browser session cookie, so a dedicated user is needed:

1. In Manager, create a dedicated user for this — name it `mcp` (or similar)
   so it's obviously not a human. **Role: "Restricted user"**, not
   Administrator — this credential lives in a plaintext env file, so keep its
   blast radius small.
2. Restricted-user role alone grants nothing — Manager has a *separate*
   permissions step. Go to **Settings → User Permissions**, edit the new
   user, and explicitly check:

   - **Purchase Invoices** with **View, Create, Update** (attachment uploads)
   - **Bank and Cash Accounts** with **View** (hourly "Check for New
     Transactions" / bank-feed sync). If the sync authenticates but Manager
     still refuses the action, add **Create, Update** on that same tab —
     View-only is the starting grant.

   Skipping this step doesn't fail auth — Basic Auth still succeeds — it
   fails *authorization*: attach attempts get Manager's own "You are not
   authorised to access this part of the system" page instead of the edit
   form, which looks identical to a login failure in `manager-mcp`'s logs
   until you actually read the response body. Grant only what the tools
   need — nothing else.
3. Add the credentials to `secrets/manager-mcp.env` (not
   `compose.yaml` — see its `MANAGER_API_KEY` for the existing pattern):
   ```
   MANAGER_UI_USERNAME=mcp
   MANAGER_UI_PASSWORD=<the password you set in step 1>
   ```
   Both are optional at the code level — if unset, attachment uploads simply
   fail (no regression to anything else) rather than the server refusing to
   start.

If attachments start failing again after a Manager upgrade or a permissions
change, `docker compose logs manager-mcp | grep attach_.*_via_api` shows the
actual request/response (status, redirect `Location`, and — on an
unexpected 200 — the full response body) for both endpoints; don't guess
from the exception text alone, log what Manager actually sent back.

`gmail-relay` additionally needs `secrets/gmail/credentials.json`
and `secrets/gmail/gcp-oauth.keys.json` (mode 0600), minted once
via `../gmail-relay/scripts/gmail_oauth_init.py` — not generated by
`docker compose up`, and not a plain env var. See below first.

### Minting `secrets/gmail/credentials.json` (one-time, manual, needs a browser)

This is separate from `docker compose up` — do it once, ahead of time, on
whatever machine has a browser (not inside the container, and not on a
headless deployment server). No npm, no third-party CLI — a small Python
stdlib-only script (`gmail-relay/scripts/gmail_oauth_init.py`) does the
standard OAuth2 loopback flow directly and reads/writes only this repo's
`secrets/gmail/`, so there's no separate `~/.gmail-mcp` directory
involved at all. Run from the **repo root**:

```sh
# In Google Cloud Console: create an OAuth client (Desktop app type), enable
# the Gmail API *and* the Drive API, download its JSON, save it as:
#   secrets/gmail/gcp-oauth.keys.json

python3 gmail-relay/scripts/gmail_oauth_init.py
# Default scopes: gmail.modify (mark a message read after relaying) and
# drive (download + delete a Drive file after a successful Receipts relay).
# Opens a browser for Google's consent screen, catches the redirect on a
# local loopback port, and writes secrets/gmail/credentials.json
# (mode 0600) directly — no copy step. Re-run this if you previously
# consented to gmail.modify only — the existing refresh token does not pick
# up new scopes.
```

- Only needs to run once — `gmail-relay` just reads `credentials.json` at
  runtime afterward and refreshes the token itself; the script never runs
  again on its own. Re-run it (re-consent) if the requested scopes ever
  change — a refresh token is scoped to what was granted at consent time.
- If the deployment host is headless, run the script on a machine with a
  browser (or forward the loopback port), then copy
  `secrets/gmail/*.json` over to the deployment host — don't try
  to complete the consent flow with no display.
- If `gmail-relay`'s `/health` later reports a token refresh failure, redo
  this step — Google can revoke long-lived refresh tokens after ~7 days for
  an OAuth consent screen still in "Testing" mode (unpublished).

Once all `secrets/*.env` files and
`secrets/gmail/*.json` are in place, from the repo root:

```sh
./deploy.sh
# or: docker compose up -d
```

## What's implemented vs. still open

Implemented here:
- Root `compose.yaml` for the stack, with `manager-mcp` and `receipts` built
  from their sibling packages (no vendoring — see spec §2), and `manager` built
  from a fork (`https://github.com/gregsteel/docker-manager.io`, branch
  `update-manager`) via the `docker-manager.io` submodule — not pulled from
  `chrborg/manager.io:latest`, whose published download URL was stale.
- `manager-mcp`'s Streamable HTTP + Google OAuth transport (see that repo's
  `http_auth.py` and README) is wired in via `MANAGER_MCP_TRANSPORT=http`.
- Hourly bank-feed sync: `MANAGER_MCP_BANK_FEED_SYNC_INTERVAL_SECONDS=3600`
  in `compose.yaml` so `manager-mcp` GETs Manager's
  `/check-for-new-transactions` UI action as the mcp user (Aussie Bank
  Feeds / "Check for New Transactions") without a UI click. Nested
  `/bank-and-cash-accounts/check-for-new-transactions` is the list tab, not
  the action. Unset or `0` disables it.
- `gmail-relay` is wired the same way (`GMAIL_RELAY_TRANSPORT=http`), reusing
  manager-mcp's `AllowlistedGoogleProvider` pattern — MCP tools gated by a
  Google-account email allowlist, not a static bearer token — since it's
  reachable from the open internet and must only ever admit Cowork.

Still open (needs the real server / real credentials / a running `home-gateway`
to actually exercise, per spec §12):
- Confirming the manager image's internal `/data` layout (`Businesses/`,
  `Blobs/`) by actually starting an empty container and inspecting it — do not
  assume it mirrors the Desktop layout (spec §6). Still unverified after the
  fork, since the fork only changes the Manager download URL, not the layout.
- The actual data migration (spec §6).
- Backups and restore testing (spec §9) — no backup job exists yet.
- `home-gateway`'s `oauth2-proxy` in front of the Manager UI route (spec §10) —
  being built in a separate session against the same spec.
- Creating the separate Google OAuth clients in Google Cloud Console — only a
  human can do this step. That's at least: Manager UI, manager-mcp, receipts,
  gmail-relay's MCP-access client (`GMAIL_RELAY_OAUTH_GOOGLE_CLIENT_ID/SECRET`),
  and gmail-relay's *Gmail + Drive API* client (`gcp-oauth.keys.json`, consumed by
  `gmail-relay/scripts/gmail_oauth_init.py`) — the latter two are distinct
  clients serving different purposes, not one.

## Note on this build

The `manager-mcp` Dockerfile (`../manager-mcp/Dockerfile`) was written and
lint/unit-tested, but **not build-verified in a running container** — Docker
Desktop wasn't reachable in the environment this was authored in
(`docker info` failed to connect to the daemon). Run `docker compose build`
from the repo root before trusting either it or the `manager` submodule build.

The `manager` service's submodule build context means the build host needs
network access to GitHub at build time (`docker compose build` / `up
--build`), unlike a plain `image:` pull. If the deployment server has no
outbound access to GitHub, build the image somewhere that does and push it to
a registry the server can pull from instead.

`gmail-relay` (`../gmail-relay`) *has* been build- and run-verified locally:
`docker compose build gmail-relay` succeeds, and the resulting image starts
correctly under `GMAIL_RELAY_TRANSPORT=http` with a fake OAuth client and
fake Gmail credentials — `/health` correctly reports `503` with the expected
"invalid_client" error in that case. Not yet verified: a real Gmail inbox
end-to-end (`search_gmail` → `relay_attachment` → a real Receipts upload) —
see `../gmail-relay/README.md`'s "Not yet done" section.
