import { NextResponse, type NextRequest } from "next/server";
import { buildGoogleAuthorizeUrl } from "@/lib/auth/google";
import {
  cookieSecure,
  createOAuthState,
  OAUTH_NATIVE_COOKIE,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/session-token";
import { MCP_OAUTH_RETURN_COOKIE } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const native = request.nextUrl.searchParams.get("native") === "1";
    const state = await createOAuthState();
    const response = NextResponse.redirect(buildGoogleAuthorizeUrl(state));
    response.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 10,
    });
    if (native) {
      response.cookies.set(OAUTH_NATIVE_COOKIE, "1", {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 10,
      });
    }
    const next = request.nextUrl.searchParams.get("next")?.trim() ?? "";
    if (next.startsWith("/oauth/authorize")) {
      response.cookies.set(MCP_OAUTH_RETURN_COOKIE, next, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 10,
      });
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth setup error";
    console.error("Google auth start error:", message);
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent("Auth is not configured")}`,
        process.env.GOOGLE_REDIRECT_URI || "http://localhost:55666",
      ),
    );
  }
}
