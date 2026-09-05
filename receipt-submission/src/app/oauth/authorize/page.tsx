import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import { decryptSession, SESSION_COOKIE } from "@/lib/auth/session-token";
import {
  parseAuthorizeParams,
  redirectUriMatches,
  resolveClient,
  type AuthorizeRequest,
  type McpClient,
} from "@/lib/mcp-oauth";

export const runtime = "nodejs";

function returnPath(searchParams: URLSearchParams): string {
  const query = searchParams.toString();
  return query ? `/oauth/authorize?${query}` : "/oauth/authorize";
}

function hiddenFields(request: AuthorizeRequest) {
  return (
    <>
      <input type="hidden" name="client_id" value={request.clientId} />
      <input type="hidden" name="redirect_uri" value={request.redirectUri} />
      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="code_challenge" value={request.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value="S256" />
      <input type="hidden" name="scope" value={request.scope} />
      {request.state ? (
        <input type="hidden" name="state" value={request.state} />
      ) : null}
      {request.resource ? (
        <input type="hidden" name="resource" value={request.resource} />
      ) : null}
    </>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && typeof value[0] === "string") {
      params.set(key, value[0]);
    }
  }

  const parsed = parseAuthorizeParams(params);
  if (!parsed.ok) {
    return errorScreen(parsed.error);
  }

  const client = await resolveClient(parsed.request.clientId);
  if (!client) {
    return errorScreen("Unknown OAuth client.");
  }
  if (
    !client.redirectUris.some((allowed) =>
      redirectUriMatches(parsed.request.redirectUri, allowed),
    )
  ) {
    return errorScreen("This redirect_uri is not registered for the client.");
  }

  const cookieStore = await cookies();
  const session = await decryptSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session || !isAllowedEmail(session.email)) {
    redirect(`/auth/google?next=${encodeURIComponent(returnPath(params))}`);
  }

  return consentScreen(client, parsed.request);
}

function errorScreen(message: string) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <p className="text-sm font-medium tracking-wide text-muted uppercase">
        Receipts
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Can’t connect
      </h1>
      <p className="mt-3 text-base leading-relaxed text-muted">{message}</p>
    </main>
  );
}

function consentScreen(client: McpClient, request: AuthorizeRequest) {
  let redirectHost = request.redirectUri;
  try {
    redirectHost = new URL(request.redirectUri).hostname;
  } catch {
    /* keep raw */
  }
  const loopback =
    redirectHost === "localhost" ||
    redirectHost === "127.0.0.1" ||
    redirectHost === "[::1]";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <p className="text-sm font-medium tracking-wide text-muted uppercase">
        Receipts
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Allow access?
      </h1>
      <p className="mt-3 text-base leading-relaxed text-muted">
        <span className="font-medium text-foreground">{client.displayHost}</span>{" "}
        wants to list, read, and annotate receipts on this server.
      </p>
      <p className="mt-2 text-sm text-muted">
        After you allow, you’ll return to{" "}
        <span className="font-medium text-foreground">{redirectHost}</span>.
      </p>
      {loopback ? (
        <p className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
          This client redirects to a loopback address on this machine. Only
          continue if you started this connection yourself.
        </p>
      ) : null}

      <form method="post" action="/oauth/approve" className="mt-8 space-y-3">
        {hiddenFields(request)}
        <button
          type="submit"
          name="decision"
          value="allow"
          className="flex h-14 w-full items-center justify-center rounded-xl bg-accent text-base font-semibold text-surface transition-colors active:bg-accent-pressed"
        >
          Allow
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="flex h-14 w-full items-center justify-center rounded-xl bg-surface text-base font-semibold text-foreground"
        >
          Deny
        </button>
      </form>
    </main>
  );
}
