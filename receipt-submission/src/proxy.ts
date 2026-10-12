import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import {
  decryptSession,
  SESSION_COOKIE,
} from "@/lib/auth/session-token";

const PUBLIC_PREFIXES = [
  "/login",
  "/auth/",
  "/health",
  "/api/health",
  "/mcp",
  "/oauth/",
  "/.well-known/",
  "/manifest.webmanifest",
  "/icon",
  "/apple-icon",
];

// Like /mcp, this only defers the decision — the route itself still
// requires a valid session, a receipt-scoped image-access token (GET),
// or a receipt-scoped image-upload token (PUT/POST)
// (src/lib/auth/image-token.ts). Needed because manager-mcp fetches
// get_receipt's imageUrl unauthenticated (no cookie, no Bearer header),
// and Cowork curl-uploads with only an upload Bearer — either would
// otherwise be rejected by this blanket session-or-Bearer gate before
// the route ever saw the request.
const PUBLIC_PATTERNS = [/^\/api\/receipts\/[^/]+\/image$/];

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix),
    ) || PUBLIC_PATTERNS.some((pattern) => pattern.test(pathname))
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    // Already signed-in users landing on login go home.
    if (pathname === "/login") {
      const session = await decryptSession(
        request.cookies.get(SESSION_COOKIE)?.value,
      );
      if (session && isAllowedEmail(session.email)) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }
    return NextResponse.next();
  }

  const session = await decryptSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  if (!session || !isAllowedEmail(session.email)) {
    if (pathname.startsWith("/api/")) {
      const auth = request.headers.get("authorization") ?? "";
      if (auth.toLowerCase().startsWith("bearer ")) {
        return NextResponse.next();
      }
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    if (pathname !== "/") {
      login.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next internals and common static assets.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js|css|map|ico)$).*)",
  ],
};
