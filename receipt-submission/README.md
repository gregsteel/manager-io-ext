# Receipt Submission

This is a simple receipt submission tool.  I made it because everything 
available is either too many clicks or is tied to a particular service.

Capture a receipt on your iPhone and save it on your receipts server. 
Any LLM can fetch, analyse, and ingest receipts over MCP.

What it does:

1. Open the **Receipts** iOS app
2. Sign in with Google
3. Tap **Capture Receipt** — the camera detects the page and crops it
4. Review the pages, then **Save**: each uploads as a JPEG plus a SQLite row

If the server is unreachable, nothing is lost — see
[Offline fallback](#offline-fallback).

[`specs/003-receipt-submission/spec.md`](../specs/003-receipt-submission/spec.md)
(in the repository root) is the full specification: architecture, auth model,
capture and image pipeline, data model, API and MCP surface, and known gaps.
`docs/SPEC.md` is now only a pointer to it.

## Deploy with Docker 
```bash
cp .env.example .env.prod
# Edit .env.prod:
#  - auth variables
#  - allowed google accounts
./deploy-docker.sh prod
```

does a fresh image build and (re)starts the `receipt-submission` container on
port **55666** with `--restart unless-stopped`. Secrets come from
`.env.$APP_ENV` at run time and are never baked into the image
(`.dockerignore` excludes `.env*`). Receipt files live in `./data` on the host
(`DATA_DIR` inside the container is `/app/data`).

On low-RAM Docker VMs (Colima often defaults to 2 GB), the build uses one CPU
and a capped Node heap. If you still see `cannot allocate memory` / `SIGKILL`,
give the VM more RAM, e.g. `colima stop && colima start --memory 4`.

Useful checks after deploy:

```bash
docker ps --filter name=receipt-submission
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:55666/health
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ALLOWED_USERS` | Yes | Comma-separated Google emails allowed to sign in |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Yes | Google sign-in OAuth client |
| `SESSION_SECRET` | Yes | Signs session cookies |
| `NATIVE_APP_REDIRECT` | No | iOS OAuth return URL (default `receipts://auth`) |
| `DATA_DIR` | No | SQLite + files directory (default `./data`, Docker `/app/data`) |

### LLM - Claude CoWork

Add a custom connector to `https://<host>/mcp`. Leave OAuth Client ID and
Secret empty. Click **Connect**, sign in with Google if asked, and Allow. The
server speaks MCP OAuth (PKCE) end to end — no static token involved.

| Method | Path | Purpose |
|---|---|---|
| POST | `/mcp` | Remote MCP (`list_receipts`, `get_receipt`, `create_receipt`, `save_receipt`, `save_analysis`, `mark_processed`) |

`get_receipt` also returns `imageUrl`: a signed, **unauthenticated**,
10-minute link straight to that one receipt's JPEG
(`{host}/api/receipts/:id/image?token=…`). It exists for handing a receipt
image to a *different* agent/MCP server that has no session or API key of
this app's own and no local filesystem to stage a file on — e.g. Cowork
passing a receipt on to `manager-mcp`'s `attach_receipt_to_purchase_invoice`
as its `file_url` argument, which fetches the URL itself with a plain `GET`.
The token is scoped to that one receipt id only (unusable for any other
receipt or any other route) and expires after 10 minutes; nothing else needs
to change for it — the image content block `get_receipt` already returns
stays exactly as before, this is additive. See
[`docs/SIGNED_IMAGE_URL.md`](docs/SIGNED_IMAGE_URL.md) for the design.

## Run locally without Docker

```bash
cp .env.example .env.local
npm install
npm run dev   # http://localhost:55666
```

Camera access needs a secure context (HTTPS or localhost).

## iOS app

Native capture lives in `ios/Receipts.xcodeproj`. A custom AVFoundation camera
finds the receipt with Vision, deskews and cleans it up, then `POST /api/send`
with the session JWT.

1. Redeploy the server so `/auth/google?native=1` and Bearer upload work.
2. Open `ios/Receipts.xcodeproj` in Xcode, set your **Team** for signing.
3. Run on a physical iPhone (the simulator has no usable camera).
4. On first launch, enter your server's URL (gear icon on the home screen to
   change or remove it later) — there is no built-in default. Sign in with
   Google, then **Capture Receipt**.

`NATIVE_APP_REDIRECT` defaults to `receipts://auth`.

Scans are downscaled (longest edge 1800 px) and JPEG-compressed to stay under
~700 KB. The home-gateway receipts vhost allows **10 MB**
(`client_max_body_size 10m`); the API itself allows 8 MB. Redeploy the gateway
after changing that template.

### Xcode Cloud (TestFlight)

The tracked project uses a placeholder bundle id (`au.com.acme.receipts`) so
the repo doesn't carry a real one. Xcode Cloud has no notion of a local
uncommitted override — it always builds exactly what's on the watched branch
— so `ios/ci_scripts/ci_post_clone.sh` swaps in your real values right after
checkout, sourced from environment variables on the workflow. In App Store
Connect: **Xcode Cloud → your workflow → Environment → Environment
Variables**, add:

| Variable | Required | Value |
|---|---|---|
| `RECEIPTS_BUNDLE_ID` | Yes | Your real bundle id, e.g. `au.com.example.receipts` |
| `RECEIPTS_DEFAULT_SERVER_URL` | No | Your server's URL — pre-fills first-run setup so a TestFlight install from this workflow skips straight to sign-in |

Neither needs **Secret** — mark both **Plain**. A bundle id and a server
hostname are already public (App Store listing, DNS); they're not
credentials. Missing `RECEIPTS_BUNDLE_ID` fails
the build loudly; missing `RECEIPTS_DEFAULT_SERVER_URL` just leaves the app's
normal manual setup screen in place.

Local device builds are separate: Xcode reads whatever `PRODUCT_BUNDLE_IDENTIFIER`
is currently in `project.pbxproj`, so set it to your real value there too —
just don't commit that change back.

### Offline fallback

When an upload fails, the app never discards the image:

1. The JPEG is written to `Documents/HeldReceipts` on the phone.
2. After Save you see a clear status, e.g.
   `Couldn't reach the server. 1 receipt couldn't be submitted and will be retried.`
3. The home screen keeps showing the same message with the waiting count, plus
   **Retry now** and **View waiting receipts** (thumbnails, swipe to delete,
   or clear all).
4. Held receipts are retried on launch, on returning to the foreground, every
   minute while the app is open, and via background app refresh.
5. On success the receipt is deleted from the phone.

The app sends `capturedAt` with the upload, so the server files a late receipt
under when it was taken rather than when it arrived.

Background app refresh is opportunistic: iOS decides when to run it. Opening
the app always forces a retry.

