import { SignJWT, jwtVerify } from "jose";

const IMAGE_TOKEN_TTL = "10m";
const IMAGE_UPLOAD_TOKEN_TTL = "30m";

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Scoped to one receipt id, short-lived, unauthenticated once issued — lets
 * an unrelated MCP server (manager-mcp) fetch a receipt image with a plain
 * GET, no session or API key of this app's own. See docs/SIGNED_IMAGE_URL.md.
 */
export async function createImageAccessToken(receiptId: string): Promise<string> {
  return new SignJWT({ purpose: "image-access", receiptId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(IMAGE_TOKEN_TTL)
    .sign(getSecretKey());
}

export async function verifyImageAccessToken(
  token: string | null,
  receiptId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    return payload.purpose === "image-access" && payload.receiptId === receiptId;
  } catch {
    return false;
  }
}

/**
 * Scoped to one receipt id — lets Cowork (or curl) PUT/POST image bytes after
 * MCP `create_receipt`. Not valid for GET; image-access tokens are not valid
 * for upload.
 */
export async function createImageUploadToken(receiptId: string): Promise<string> {
  return new SignJWT({ purpose: "image-upload", receiptId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(IMAGE_UPLOAD_TOKEN_TTL)
    .sign(getSecretKey());
}

export async function verifyImageUploadToken(
  token: string | null,
  receiptId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    return payload.purpose === "image-upload" && payload.receiptId === receiptId;
  } catch {
    return false;
  }
}
