/**
 * Cloudflare Email Worker: hands every message sent to the receipts address to
 * receipt-submission's `POST /api/inbound/email` as raw RFC 822, authenticated
 * with a shared bearer secret. All parsing, sender checks (ALLOWED_USERS) and
 * attachment handling happen in the app — this Worker is deliberately a dumb
 * pipe so there is one place that decides what counts as a receipt.
 */

export interface Env {
  /** e.g. https://receipts.example.com/api/inbound/email (wrangler.toml [vars]) */
  INBOUND_URL: string;
  /** Same value as INBOUND_EMAIL_SECRET on the receipts server (`wrangler secret put`). */
  INBOUND_EMAIL_SECRET: string;
}

// Cloudflare Email Routing's own per-message cap.
const MAX_RAW_BYTES = 25 * 1024 * 1024;

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (message.rawSize > MAX_RAW_BYTES) {
      console.warn(`Dropping oversized message (${message.rawSize} bytes) from ${message.from}`);
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(env.INBOUND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.INBOUND_EMAIL_SECRET}`,
        "Content-Type": "message/rfc822",
        "X-Envelope-From": message.from,
        "X-Envelope-To": message.to,
      },
      body: raw,
    });

    if (res.ok) return;

    const detail = await res.text().catch(() => "");
    if (res.status >= 500) {
      // The app is down or failed unexpectedly. Throw so the delivery fails
      // visibly instead of silently losing a receipt; the app's ingestion is
      // idempotent per Message-ID, so a retry cannot create duplicates.
      throw new Error(`Receipts app returned ${res.status}: ${detail}`);
    }

    // 401/403/4xx: wrong secret, sender not in ALLOWED_USERS, or malformed.
    // Drop quietly rather than setReject() — a bounce goes to the (possibly
    // forged) original sender, which would be backscatter spam.
    console.warn(`Receipts app refused message from ${message.from}: ${res.status} ${detail}`);
  },
};
