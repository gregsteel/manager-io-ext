import { cookies } from "next/headers";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import {
  cookieSecure,
  decryptSession,
  encryptSession,
  SESSION_COOKIE,
  sessionExpiresAt,
  type SessionPayload,
} from "@/lib/auth/session-token";

export async function createSession(user: {
  email: string;
  name?: string;
  picture?: string;
}): Promise<void> {
  const expiresAt = sessionExpiresAt();
  const token = await encryptSession({
    email: user.email.toLowerCase(),
    name: user.name,
    picture: user.picture,
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/** Returns the session only if the email is still on ALLOWED_USERS. */
export async function getSession(
  request?: Request,
): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const header = request?.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const token = bearer || cookieStore.get(SESSION_COOKIE)?.value;
  const session = await decryptSession(token);
  if (!session || !isAllowedEmail(session.email)) {
    return null;
  }
  return session;
}
