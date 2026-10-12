import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ingestInboundEmail } from "@/lib/inbound-email";

export const runtime = "nodejs";

// Cloudflare Email Routing caps a message at 25 MiB; leave headroom for the
// Worker's own overhead rather than matching it exactly.
const MAX_RAW_BYTES = 30 * 1024 * 1024;

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
}

function secretMatches(presented: string, expected: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Inbound email from the Cloudflare Email Worker (`email-worker/`): the raw
 * RFC 822 message as the body, authenticated by the shared
 * `INBOUND_EMAIL_SECRET` bearer rather than a user session — the caller is the
 * Worker, not a person. Who the *mail* is from is then checked against
 * ALLOWED_USERS inside `ingestInboundEmail`.
 */
export async function POST(request: Request) {
  const secret = process.env.INBOUND_EMAIL_SECRET?.trim();
  if (!secret) {
    // Fail closed: an unset secret must never mean "accept anyone".
    return NextResponse.json(
      { error: "Inbound email is not configured" },
      { status: 503 },
    );
  }
  if (!secretMatches(bearerToken(request), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) {
    return NextResponse.json({ error: "Message too large" }, { status: 413 });
  }
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length === 0) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }
  if (raw.length > MAX_RAW_BYTES) {
    return NextResponse.json({ error: "Message too large" }, { status: 413 });
  }

  try {
    const result = await ingestInboundEmail(raw);

    if (result.status === "rejected") {
      console.warn(
        `Inbound email rejected: ${result.reason} (claimed: ${
          result.identities.join(", ") || "none"
        })`,
      );
      return NextResponse.json({ error: result.reason }, { status: 403 });
    }
    if (result.status === "confirmation") {
      return NextResponse.json({ ok: true, confirmation: true });
    }

    console.info(
      `Inbound email ${result.messageId} from ${result.submittedBy}: ` +
        `${result.stored.length} stored, ${result.duplicates} duplicate, ` +
        `${result.skipped.length} skipped` +
        (result.skipped.length
          ? ` (${result.skipped.map((s) => `${s.filename}: ${s.reason}`).join("; ")})`
          : ""),
    );
    return NextResponse.json({
      ok: true,
      stored: result.stored.map((r) => ({ id: r.id, filename: r.filename })),
      duplicates: result.duplicates,
      skipped: result.skipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("Inbound email error:", message);
    // 5xx so the Worker surfaces a failure and the mail is retried;
    // ingestion is idempotent per (Message-ID, attachment).
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
