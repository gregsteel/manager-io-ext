import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import { decryptSession, SESSION_COOKIE } from "@/lib/auth/session-token";
import {
  issueAuthorizationCode,
  oauthErrorRedirect,
  parseAuthorizeParams,
  redirectUriMatches,
  resolveClient,
} from "@/lib/mcp-oauth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params.set(key, value);
  }

  const parsed = parseAuthorizeParams(params);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const client = await resolveClient(parsed.request.clientId);
  if (
    !client ||
    !client.redirectUris.some((allowed) =>
      redirectUriMatches(parsed.request.redirectUri, allowed),
    )
  ) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  const decision = params.get("decision");
  if (decision !== "allow") {
    return NextResponse.redirect(
      oauthErrorRedirect(
        parsed.request.redirectUri,
        "access_denied",
        parsed.request.state,
        "The user denied access",
      ),
      303,
    );
  }

  const session = await decryptSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session || !isAllowedEmail(session.email)) {
    return NextResponse.redirect(
      new URL("/oauth/authorize?" + params.toString(), request.url),
    );
  }

  const code = await issueAuthorizationCode({
    email: session.email,
    request: parsed.request,
  });
  const dest = new URL(parsed.request.redirectUri);
  dest.searchParams.set("code", code);
  if (parsed.request.state) dest.searchParams.set("state", parsed.request.state);
  return NextResponse.redirect(dest, 303);
}
