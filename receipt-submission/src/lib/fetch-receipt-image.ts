import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const RECEIPT_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type FetchedReceiptImage = {
  bytes: Buffer;
  mimeType: string;
};

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return true;
}

function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("imageUrl is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("imageUrl must be an https URL");
  }
  if (url.username || url.password) {
    throw new Error("imageUrl must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("imageUrl host is not allowed");
  }
  if (isIP(host) && isPrivateOrReservedIp(host)) {
    throw new Error("imageUrl host is not allowed");
  }
  return url;
}

async function assertResolvesPublic(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error("imageUrl host is not allowed");
    }
    return;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("imageUrl host could not be resolved");
  }
  if (addresses.length === 0) {
    throw new Error("imageUrl host could not be resolved");
  }
  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error("imageUrl host is not allowed");
    }
  }
}

export function isAllowedReceiptImageMime(mimeType: string): boolean {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!base) return false;
  if (base === "application/pdf") return false;
  if (ALLOWED_MIME_TYPES.has(base)) return true;
  return base.startsWith("image/");
}

export function decodeReceiptImageBase64(
  imageBase64: string,
  mimeType: string,
): FetchedReceiptImage {
  const cleaned = imageBase64.replace(/\s+/g, "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cleaned, "base64");
  } catch {
    throw new Error("imageBase64 is not valid base64");
  }
  if (bytes.length === 0) {
    throw new Error("imageBase64 decoded to empty content");
  }
  if (bytes.length > RECEIPT_IMAGE_MAX_BYTES) {
    throw new Error("Image is too large (max 8 MB)");
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() || "image/jpeg";
  if (normalized === "application/pdf") {
    throw new Error("PDF invoices are not supported; provide an image");
  }
  if (!isAllowedReceiptImageMime(normalized)) {
    throw new Error("File must be an image");
  }
  return { bytes, mimeType: normalized };
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error("Image is too large (max 8 MB)");
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Image is too large (max 8 MB)");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Fetch a receipt image from an HTTPS URL with SSRF guards, size cap, and mime checks.
 */
export async function fetchReceiptImageFromUrl(
  imageUrl: string,
): Promise<FetchedReceiptImage> {
  let current = assertPublicHttpsUrl(imageUrl);
  await assertResolvesPublic(current.hostname);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "image/*,*/*;q=0.8" },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("imageUrl redirect missing Location");
        }
        if (redirect === MAX_REDIRECTS) {
          throw new Error("imageUrl followed too many redirects");
        }
        const next = new URL(location, current);
        current = assertPublicHttpsUrl(next.toString());
        await assertResolvesPublic(current.hostname);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch imageUrl (HTTP ${response.status})`);
      }

      const headerType =
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
        "";
      if (headerType === "application/pdf") {
        throw new Error("PDF invoices are not supported; provide an image");
      }
      if (headerType && !isAllowedReceiptImageMime(headerType)) {
        throw new Error("File must be an image");
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > RECEIPT_IMAGE_MAX_BYTES) {
          throw new Error("Image is too large (max 8 MB)");
        }
      }

      const bytes = await readBodyCapped(response, RECEIPT_IMAGE_MAX_BYTES);
      if (bytes.length === 0) {
        throw new Error("imageUrl returned empty content");
      }

      const mimeType =
        headerType && isAllowedReceiptImageMime(headerType)
          ? headerType
          : "image/jpeg";
      return { bytes, mimeType };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Timed out fetching imageUrl");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("imageUrl followed too many redirects");
}
