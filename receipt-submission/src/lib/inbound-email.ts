import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import { RECEIPT_IMAGE_MAX_BYTES } from "@/lib/fetch-receipt-image";
import { renderPdfToJpeg } from "@/lib/pdf-to-image";
import {
  findEmailReceipt,
  saveReceipt,
  type ReceiptRecord,
} from "@/lib/receipts-store";

/** Inline images smaller than this are almost always signature logos and
 * social icons, not a photographed receipt. Anything else — including small
 * *attached* files — is stored and left for Cowork to judge. */
const INLINE_IMAGE_MIN_BYTES = 20 * 1024;
const SNIPPET_MAX_CHARS = 600;
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};
const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";

type Email = Awaited<ReturnType<typeof PostalMime.parse>>;
type Attachment = Email["attachments"][number];

export type SkippedAttachment = { filename: string; reason: string };

export type InboundEmailResult =
  | {
      status: "rejected";
      reason: string;
      /** Addresses the mail claimed to come from, for the operator's log. */
      identities: string[];
    }
  | { status: "confirmation" }
  | {
      status: "ok";
      messageId: string;
      submittedBy: string;
      stored: ReceiptRecord[];
      /** Attachments already stored by an earlier delivery of this email. */
      duplicates: number;
      skipped: SkippedAttachment[];
    };

function firstAddress(text: string | undefined): string | null {
  const match = text?.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Who the mail says it came from, most trustworthy claim first.
 *
 * - `X-Forwarded-For: <forwarding account> <destination>` is set by Gmail on
 *   filter/auto-forwarded mail, and names the *Gmail account that forwarded
 *   it* — the identity ALLOWED_USERS is about. Only the first header counts:
 *   each hop prepends its own, so the first is the most recent hop (the one
 *   that delivered to us).
 * - `From:` covers a person manually forwarding or sending a receipt from an
 *   allowed address.
 *
 * Both are headers, so a sender who knows the (unguessable) receiving address
 * and the allowed email could forge them — see the security note in the spec.
 */
export function claimedSenders(email: Email): string[] {
  const forwardedFor = email.headers.find((h) => h.key === "x-forwarded-for");
  const candidates = [
    firstAddress(forwardedFor?.value),
    email.from?.address?.toLowerCase() ?? null,
  ];
  return [...new Set(candidates.filter((a): a is string => a !== null))];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function snippetOf(email: Email): string {
  const source =
    email.text?.trim() ||
    (email.html ?? "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ");
  return collapse(source).slice(0, SNIPPET_MAX_CHARS);
}

function attachmentBytes(attachment: Attachment): Buffer {
  const { content } = attachment;
  if (typeof content === "string") {
    return Buffer.from(content, attachment.encoding === "base64" ? "base64" : "utf8");
  }
  return Buffer.from(content as ArrayBuffer);
}

function extensionOf(filename: string | null): string {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

/** `"pdf"`, an `image/*` MIME type we store, or null for anything else
 * (Word docs, calendar invites, zips...) — those can't be a receipt row. */
function classify(attachment: Attachment): "pdf" | string | null {
  const declared = attachment.mimeType.toLowerCase();
  if (declared === "application/pdf") return "pdf";
  if (IMAGE_MIME_TYPES.has(declared)) return declared;
  if (declared === "application/octet-stream" || declared === "") {
    const inferred = EXTENSION_MIME_TYPES[extensionOf(attachment.filename)];
    if (inferred === "application/pdf") return "pdf";
    if (inferred) return inferred;
  }
  return null;
}

/** Display name for the stored JPEG: the attachment's own name, sanitised,
 * since the row is always a `.jpg` on disk whatever it arrived as. */
function storedFilename(original: string | null, index: number): string {
  const base = (original ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w .()-]/g, "_")
    .trim()
    .slice(0, 100);
  return `${base || `attachment-${index + 1}`}.jpg`;
}

function formatFrom(email: Email): string {
  const from = email.from;
  if (!from?.address) return "";
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

/**
 * Parse one raw RFC 822 message and store each receipt-shaped attachment as
 * its own receipt row, tagged with the email it came from so Cowork can tell
 * a receipt from the other things attached to the same email.
 *
 * Idempotent per (Message-ID, attachment position): a re-delivered email adds
 * nothing. Deterministic per-attachment problems (unreadable PDF, too large,
 * not an image) are reported in `skipped` rather than failing the whole
 * email; unexpected errors (disk, database) throw so the sender retries.
 */
export async function ingestInboundEmail(raw: Buffer): Promise<InboundEmailResult> {
  const email = await PostalMime.parse(raw);

  if (
    email.from?.address?.toLowerCase() === GMAIL_FORWARDING_SENDER &&
    /forwarding confirmation/i.test(email.subject ?? "")
  ) {
    // Gmail verifies a new forwarding address by mailing it a code. Nothing to
    // store — surface it in the server log so the operator can complete setup.
    console.info(
      "Inbound email: Gmail forwarding confirmation —",
      collapse(email.text ?? "").slice(0, 400),
    );
    return { status: "confirmation" };
  }

  const identities = claimedSenders(email);
  const submittedBy = identities.find((address) => isAllowedEmail(address));
  if (!submittedBy) {
    return {
      status: "rejected",
      reason: "Sender is not in ALLOWED_USERS",
      identities,
    };
  }

  const messageId =
    email.messageId?.trim() ||
    `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const subject = email.subject?.trim() ?? "";
  const from = formatFrom(email);
  const snippet = snippetOf(email);

  const stored: ReceiptRecord[] = [];
  const skipped: SkippedAttachment[] = [];
  let duplicates = 0;

  for (const [index, attachment] of email.attachments.entries()) {
    const label = attachment.filename ?? `attachment-${index + 1}`;

    if (findEmailReceipt(messageId, index)) {
      duplicates += 1;
      continue;
    }

    const kind = classify(attachment);
    if (!kind) {
      skipped.push({ filename: label, reason: `unsupported type ${attachment.mimeType}` });
      continue;
    }

    const bytes = attachmentBytes(attachment);
    if (bytes.length === 0) {
      skipped.push({ filename: label, reason: "empty" });
      continue;
    }
    if (bytes.length > RECEIPT_IMAGE_MAX_BYTES) {
      skipped.push({ filename: label, reason: "larger than 8 MB" });
      continue;
    }
    const inline = attachment.related || attachment.disposition === "inline";
    if (kind !== "pdf" && inline && bytes.length < INLINE_IMAGE_MIN_BYTES) {
      skipped.push({ filename: label, reason: "small inline image (logo/icon)" });
      continue;
    }

    let image = bytes;
    let mimeType = kind;
    if (kind === "pdf") {
      try {
        const converted = await renderPdfToJpeg(bytes);
        image = converted.bytes;
        mimeType = converted.mimeType;
      } catch (err) {
        skipped.push({
          filename: label,
          reason: err instanceof Error ? err.message : "could not convert PDF",
        });
        continue;
      }
    }

    stored.push(
      await saveReceipt({
        bytes: image,
        submittedBy,
        filename: storedFilename(attachment.filename, index),
        mimeType,
        email: {
          messageId,
          subject,
          from,
          snippet,
          originalFilename: attachment.filename ?? "",
          attachmentIndex: index,
        },
      }),
    );
  }

  return { status: "ok", messageId, submittedBy, stored, duplicates, skipped };
}
