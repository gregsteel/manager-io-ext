# manager-io-ext

## Architecture

Scheduled Claude Cowork tasks drive the accounting stack:
- `docker-manager.io` is a dockerised deployment of Manager.io server
- `manager-mcp` is an MCP server that wraps Manager.io and performs supporting functions such as polling for bank transactions.  It is forked from [flumpiey/manager-mcp](https://github.com/flumpiey/manager-mcp)
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
data/                # bind mounts — gitignored
  manager/           # -> /data in the manager container
  receipts/          # -> /app/data in the receipts container
```

```sh
cp secrets/manager-mcp.env.example secrets/manager-mcp.env
cp secrets/receipts.env.example secrets/receipts.env
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
bank-feed sync is the same: every bank-feed provider (see
`manager-mcp/src/manager_mcp/bank_feed_providers/`, pluggable — Aussie Bank
Feeds/Basiq ships built in) wants HTTP Basic Auth, not `X-API-KEY` and not
the old `/api/…` namespace (that one 401s before routing). Manager
accepts Basic Auth using a real Manager user account as an alternative to a
browser session cookie, so a dedicated user is needed. Once the mcp user and
`MANAGER_MCP_TRANSPORT=http` are both set up, `/setup/bank-feeds` (gated by
the same Google login used for remote MCP access) walks through configuring
a provider — it reads what it can from Manager and only asks for what it
can't (e.g. the Aussie Bank Feeds login); see `manager-mcp/README.md`'s
"Bank-feed providers" section.

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

Once all `secrets/*.env` files are in place, from the repo root:

```sh
./deploy.sh
# or: docker compose up -d
```

## Webhook auto-deploy

Pushes to `main` can trigger an automatic `git pull && ./deploy.sh` on the
deploy server via a `webhook` service (`lwlook/webhook`, wrapping
`adnanh/webhook`), gated by HMAC-SHA256 signature verification. See
[webhook/README.md](webhook/README.md) for full setup — both the no-public-
endpoint route (`gh webhook forward`, the default for this project) and the
direct-GitHub-webhook-through-a-reverse-proxy alternative.

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
  in `compose.yaml` so `manager-mcp` runs whichever bank-feed provider is
  configured (Aussie Bank Feeds/Basiq ships built in — see
  `manager-mcp/README.md`'s "Bank-feed providers" section) as the mcp
  user, without a UI click. Unset or `0` disables it.

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
  human can do this step: Manager UI, manager-mcp and receipts.

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
