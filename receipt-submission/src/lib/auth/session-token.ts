import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export const SESSION_COOKIE = "session";
export const OAUTH_STATE_COOKIE = "oauth_state";
export const OAUTH_NATIVE_COOKIE = "oauth_native";

// Chrome caps persistent cookies at ~400 days; match that ceiling.
const SESSION_DAYS = 400;

export type SessionUser = {
  email: string;
  name?: string;
  picture?: string;
};

export type SessionPayload = JWTPayload & SessionUser;

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return new TextEncoder().encode(secret);
}

export function sessionExpiresAt(): Date {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

export async function encryptSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    purpose: "session",
    email: user.email,
    name: user.name,
    picture: user.picture,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getSecretKey());
}

export async function decryptSession(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const secret = process.env.SESSION_SECRET?.trim();
    if (!secret) return null;
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ["HS256"] },
    );
    if (payload.purpose && payload.purpose !== "session") return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) return null;
    return { ...payload, email };
  } catch {
    return null;
  }
}

export function cookieSecure(): boolean {
  // Must match the actual page origin. Docker local is NODE_ENV=production
  // with http://localhost — a Secure cookie is dropped by the browser.
  const redirect = process.env.GOOGLE_REDIRECT_URI?.trim() ?? "";
  return redirect.startsWith("https://");
}

export async function createOAuthState(): Promise<string> {
  return new SignJWT({ purpose: "oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getSecretKey());
}

export async function verifyOAuthState(state: string | null): Promise<boolean> {
  if (!state) return false;
  try {
    const { payload } = await jwtVerify(state, getSecretKey(), {
      algorithms: ["HS256"],
    });
    return payload.purpose === "oauth";
  } catch {
    return false;
  }
}
