# email-worker

Cloudflare Email Worker that delivers receipt emails to `receipt-submission`.
Gmail forwards to an unguessable address on your domain; Cloudflare Email
Routing hands the message to this Worker; the Worker POSTs the raw message to
`/api/inbound/email`, which stores each receipt-shaped attachment as its own
receipt (see `../specs/003-receipt-submission/spec.md`, User Story 7 and §7). Nothing
here holds a Google credential, so nothing here expires.

## Setup

1. **Receipts server** — set `INBOUND_EMAIL_SECRET` in `secrets/receipts.env`
   (`openssl rand -base64 32`) and redeploy. Unset means the route returns
   `503` and accepts nothing. The sender must also be in `ALLOWED_USERS`.
2. **Reverse proxy** — the route takes up to 30 MB of raw MIME; raise
   `client_max_body_size` (nginx) on `/api/inbound/email` to at least `30m`.
3. **Deploy the Worker** (domain must be on Cloudflare, with Email Routing
   enabled — that adds the MX/SPF records):
   ```sh
   cd email-worker
   npm install
   cp wrangler.toml.example wrangler.toml   # gitignored; set INBOUND_URL to your receipts host
   npx wrangler secret put INBOUND_EMAIL_SECRET   # same value as step 1
   npx wrangler deploy
   ```
4. **Route** — Cloudflare dashboard → Email → Email Routing → Routes → create a
   custom address with a long random local part (e.g. `receipts-k3x9q2m7`, not
   `receipts`) → action **Send to a Worker** → `receipts-email-worker`.
5. **Gmail** — Settings → Forwarding and POP/IMAP → *Add a forwarding address*
   with that address. Gmail mails a confirmation code to it; the receipts app
   recognises that message and writes the code to its log:
   `docker logs accounting-receipts | grep "forwarding confirmation"`.
   Confirm, then create a filter (e.g. `has:attachment label:receipts`) with
   *Forward it to* that address.

You can also forward a receipt by hand from the allowed Gmail account to the
same address.

## Behaviour

- The app answers `2xx` once the message is stored (or was already stored).
- `5xx` makes the Worker throw so the delivery fails visibly; re-delivery is
  safe because ingestion is idempotent per `Message-ID` + attachment position.
- `401`/`403`/other `4xx` (wrong secret, sender not allowed, malformed) are
  logged and dropped, not bounced — a bounce would go to the original sender,
  who may be forged.
- Email with no attachments (receipt is in the body only) stores nothing.
