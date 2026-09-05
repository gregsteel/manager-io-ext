import { NextResponse, type NextRequest } from "next/server";
import { appOrigin } from "@/lib/app-origin";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import { exchangeCodeForUser } from "@/lib/auth/google";
import {
  cookieSecure,
  encryptSession,
  OAUTH_NATIVE_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  sessionExpiresAt,
  verifyOAuthState,
} from "@/lib/auth/session-token";
import { MCP_OAUTH_RETURN_COOKIE } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

function loginRedirect(error: string): NextResponse {
  const url = new URL("/login", appOrigin());
  url.searchParams.set("error", error);
  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_NATIVE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return loginRedirect("Google sign-in was cancelled");
  }

  if (!code || !state) {
    return loginRedirect("Missing Google auth response");
  }

  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const stateOk = await verifyOAuthState(state);
  if (!stateOk || (expectedState && expectedState !== state)) {
    return loginRedirect("Invalid sign-in state. Try again.");
  }

  try {
    const user = await exchangeCodeForUser(code);
    if (!isAllowedEmail(user.email)) {
      return loginRedirect("Your account is not allowed to use this app");
    }

    const expiresAt = sessionExpiresAt();
    const token = await encryptSession({
      email: user.email.toLowerCase(),
      name: user.name,
      picture: user.picture,
    });

    const native = request.cookies.get(OAUTH_NATIVE_COOKIE)?.value === "1";
    if (native) {
      const appRedirect =
        process.env.NATIVE_APP_REDIRECT?.trim() || "receipts://auth";
      const nativeUrl = new URL(appRedirect);
      nativeUrl.searchParams.set("token", token);
      const nativeResponse = NextResponse.redirect(nativeUrl);
      nativeResponse.cookies.delete(OAUTH_STATE_COOKIE);
      nativeResponse.cookies.delete(OAUTH_NATIVE_COOKIE);
      return nativeResponse;
    }

    const mcpReturn = request.cookies.get(MCP_OAUTH_RETURN_COOKIE)?.value ?? "";
    const dest =
      mcpReturn.startsWith("/oauth/authorize")
        ? new URL(mcpReturn, appOrigin())
        : new URL("/", appOrigin());
    const response = NextResponse.redirect(dest);
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      expires: expiresAt,
      path: "/",
    });
    response.cookies.delete(OAUTH_STATE_COOKIE);
    response.cookies.delete(MCP_OAUTH_RETURN_COOKIE);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sign-in failed";
    console.error("Google auth callback error:", message);
    return loginRedirect("Google sign-in failed. Try again.");
  }
}
