import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session-token";

export const runtime = "nodejs";

function appOrigin(requestUrl: string): string {
  const redirect = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (redirect) {
    try {
      return new URL(redirect).origin;
    } catch {
      /* fall through */
    }
  }
  return new URL(requestUrl).origin;
}

function clearAndRedirect(request: Request): NextResponse {
  const response = NextResponse.redirect(new URL("/login", appOrigin(request.url)), {
    status: 303,
  });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  return clearAndRedirect(request);
}

export async function GET(request: Request) {
  return clearAndRedirect(request);
}
