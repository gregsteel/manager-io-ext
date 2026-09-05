import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { isAllowedEmail } from "@/lib/auth/allowed-users";
import { appOrigin, mcpResourceUrl } from "@/lib/app-origin";
import {
  consumeAuthCode,
  consumeRefreshToken,
  getRegisteredClient,
  insertAuthCode,
  insertRefreshToken,
  saveRegisteredClient,
  type RegisteredClient,
} from "@/lib/mcp-oauth-store";

export const MCP_SCOPE = "receipts";
export const MCP_OAUTH_RETURN_COOKIE = "mcp_oauth_return";

const ACCESS_TOKEN_MINUTES = 60;
const AUTH_CODE_MINUTES = 10;
const REFRESH_TOKEN_DAYS = 30;

export type McpClient = {
  clientId: string;
  clientSecret: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  displayHost: string;
};

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
};

type AuthCodePayload = JWTPayload & {
  purpose: "mcp_auth_code";
  email: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
};

type AccessPayload = JWTPayload & {
  purpose: "mcp_access";
  email: string;
  client_id: string;
  scope: string;
};

type RefreshPayload = JWTPayload & {
  purpose: "mcp_refresh";
  email: string;
  client_id: string;
  scope: string;
};

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return new TextEncoder().encode(secret);
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function redirectUriMatches(requested: string, allowed: string): boolean {
  if (requested === allowed) return true;
  try {
    const req = new URL(requested);
    const all = new URL(allowed);
    if (req.protocol !== all.protocol) return false;
    if (req.hostname !== all.hostname) return false;
    if (req.pathname !== all.pathname) return false;
    if (req.search !== all.search) return false;
    if (!isLoopbackHost(req.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function redirectUriAllowed(requested: string, allowed: string[]): boolean {
  return allowed.some((entry) => redirectUriMatches(requested, entry));
}

function clientHost(clientId: string): string {
  try {
    if (clientId.startsWith("https://") || clientId.startsWith("http://")) {
      return new URL(clientId).hostname;
    }
  } catch {
    /* ignore */
  }
  return clientId;
}

export function mcpWwwAuthenticate(): string {
  const metadata = `${appOrigin()}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${MCP_SCOPE}"`;
}

export function protectedResourceMetadata() {
  const resource = mcpResourceUrl();
  return {
    resource,
    authorization_servers: [appOrigin()],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
  };
}

export function authorizationServerMetadata() {
  const origin = appOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [MCP_SCOPE, "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  };
}

async function resolveCimdClient(clientId: string): Promise<McpClient | null> {
  if (!clientId.startsWith("https://")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(clientId, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as {
      client_id?: unknown;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: unknown;
    };
    if (doc.client_id !== clientId) return null;
    if (!Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (redirectUris.length === 0) return null;
    return {
      clientId,
      clientSecret: null,
      redirectUris,
      tokenEndpointAuthMethod:
        typeof doc.token_endpoint_auth_method === "string"
          ? doc.token_endpoint_auth_method
          : "none",
      displayHost: clientHost(clientId),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fromRegistered(row: RegisteredClient): McpClient {
  return {
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    redirectUris: row.redirectUris,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    displayHost: clientHost(row.clientId),
  };
}

export async function resolveClient(clientId: string): Promise<McpClient | null> {
  if (!clientId) return null;
  const cimd = await resolveCimdClient(clientId);
  if (cimd) return cimd;
  const registered = getRegisteredClient(clientId);
  return registered ? fromRegistered(registered) : null;
}

export function parseAuthorizeParams(
  params: URLSearchParams,
): { ok: true; request: AuthorizeRequest } | { ok: false; error: string } {
  const clientId = params.get("client_id")?.trim() ?? "";
  const redirectUri = params.get("redirect_uri")?.trim() ?? "";
  const responseType = params.get("response_type")?.trim() ?? "";
  const codeChallenge = params.get("code_challenge")?.trim() ?? "";
  const method = params.get("code_challenge_method")?.trim() ?? "";
  const state = params.get("state");
  const resource = params.get("resource");

  if (!clientId) return { ok: false, error: "Missing client_id" };
  if (responseType !== "code") {
    return { ok: false, error: "response_type must be code" };
  }
  if (!redirectUri) return { ok: false, error: "Missing redirect_uri" };
  if (!codeChallenge) return { ok: false, error: "PKCE code_challenge is required" };
  if (method && method !== "S256") {
    return { ok: false, error: "code_challenge_method must be S256" };
  }
  if (resource && resource !== mcpResourceUrl()) {
    return { ok: false, error: "resource does not match this MCP server" };
  }

  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scope: MCP_SCOPE,
      resource,
    },
  };
}

export function oauthErrorRedirect(
  redirectUri: string,
  error: string,
  state: string | null,
  description?: string,
): URL {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url;
}

export async function issueAuthorizationCode(input: {
  email: string;
  request: AuthorizeRequest;
}): Promise<string> {
  const jti = randomUUID();
  insertAuthCode(jti);
  return new SignJWT({
    purpose: "mcp_auth_code",
    email: input.email.toLowerCase(),
    client_id: input.request.clientId,
    redirect_uri: input.request.redirectUri,
    code_challenge: input.request.codeChallenge,
    scope: input.request.scope,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${AUTH_CODE_MINUTES}m`)
    .sign(getSecretKey());
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readAuthCode(code: string): Promise<AuthCodePayload | null> {
  try {
    const { payload } = await jwtVerify(code, getSecretKey(), {
      algorithms: ["HS256"],
    });
    if (payload.purpose !== "mcp_auth_code") return null;
    if (typeof payload.jti !== "string") return null;
    if (typeof payload.email !== "string") return null;
    if (typeof payload.client_id !== "string") return null;
    if (typeof payload.redirect_uri !== "string") return null;
    if (typeof payload.code_challenge !== "string") return null;
    if (typeof payload.scope !== "string") return null;
    if (!consumeAuthCode(payload.jti)) return null;
    return payload as AuthCodePayload;
  } catch {
    return null;
  }
}

async function issueAccessToken(input: {
  email: string;
  clientId: string;
  scope: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const accessToken = await new SignJWT({
    purpose: "mcp_access",
    email: input.email.toLowerCase(),
    client_id: input.clientId,
    scope: input.scope,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(mcpResourceUrl())
    .setIssuer(appOrigin())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_MINUTES}m`)
    .sign(getSecretKey());
  return { accessToken, expiresIn: ACCESS_TOKEN_MINUTES * 60 };
}

async function issueRefreshToken(input: {
  email: string;
  clientId: string;
  scope: string;
}): Promise<string> {
  const jti = randomUUID();
  const expires = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  insertRefreshToken({
    jti,
    clientId: input.clientId,
    email: input.email.toLowerCase(),
    scope: input.scope,
    expiresAt: expires.toISOString(),
  });
  return new SignJWT({
    purpose: "mcp_refresh",
    email: input.email.toLowerCase(),
    client_id: input.clientId,
    scope: input.scope,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TOKEN_DAYS}d`)
    .sign(getSecretKey());
}

export async function issueTokenPair(input: {
  email: string;
  clientId: string;
  scope: string;
}): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  const access = await issueAccessToken(input);
  const refreshToken = await issueRefreshToken(input);
  return {
    access_token: access.accessToken,
    token_type: "Bearer",
    expires_in: access.expiresIn,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

function parseBasicClient(header: string | null): {
  clientId: string;
  clientSecret: string;
} | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const cut = decoded.indexOf(":");
    if (cut < 0) return null;
    return {
      clientId: decoded.slice(0, cut),
      clientSecret: decoded.slice(cut + 1),
    };
  } catch {
    return null;
  }
}

function clientSecretMatches(client: McpClient, provided: string | null): boolean {
  if (client.tokenEndpointAuthMethod === "none" || !client.clientSecret) {
    return true;
  }
  if (!provided) return false;
  return equal(client.clientSecret, provided);
}

export async function handleTokenRequest(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return jsonError("invalid_request", "Use application/x-www-form-urlencoded", 415);
  }

  const body = await request.text();
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type")?.trim() ?? "";
  const basic = parseBasicClient(request.headers.get("authorization"));
  const clientId = (params.get("client_id") ?? basic?.clientId ?? "").trim();
  const clientSecret = params.get("client_secret") ?? basic?.clientSecret ?? null;
  const resource = params.get("resource");

  if (resource && resource !== mcpResourceUrl()) {
    return jsonError("invalid_target", "resource does not match this MCP server");
  }

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const verifier = params.get("code_verifier") ?? "";
    const payload = await readAuthCode(code);
    if (!payload) {
      return jsonError("invalid_grant", "Authorization code is invalid or used");
    }
    if (payload.redirect_uri !== redirectUri) {
      return jsonError("invalid_grant", "redirect_uri mismatch");
    }
    if (!verifier || !equal(pkceChallenge(verifier), payload.code_challenge)) {
      return jsonError("invalid_grant", "PKCE verification failed");
    }
    if (clientId && clientId !== payload.client_id) {
      return jsonError("invalid_client", "client_id mismatch");
    }
    const client = await resolveClient(payload.client_id);
    if (!client || !clientSecretMatches(client, clientSecret)) {
      return jsonError("invalid_client", "Unknown or unauthorized client", 401);
    }
    if (!isAllowedEmail(payload.email)) {
      return jsonError("invalid_grant", "User is no longer allowed");
    }
    const tokens = await issueTokenPair({
      email: payload.email,
      clientId: payload.client_id,
      scope: payload.scope,
    });
    return Response.json(tokens);
  }

  if (grantType === "refresh_token") {
    const refresh = params.get("refresh_token") ?? "";
    try {
      const { payload } = await jwtVerify(refresh, getSecretKey(), {
        algorithms: ["HS256"],
      });
      if (payload.purpose !== "mcp_refresh" || typeof payload.jti !== "string") {
        return jsonError("invalid_grant", "Refresh token is invalid");
      }
      const stored = consumeRefreshToken(payload.jti);
      if (!stored) {
        return jsonError("invalid_grant", "Refresh token is invalid or rotated");
      }
      if (clientId && clientId !== stored.clientId) {
        return jsonError("invalid_client", "client_id mismatch");
      }
      const client = await resolveClient(stored.clientId);
      if (!client || !clientSecretMatches(client, clientSecret)) {
        return jsonError("invalid_client", "Unknown or unauthorized client");
      }
      if (!isAllowedEmail(stored.email)) {
        return jsonError("invalid_grant", "User is no longer allowed");
      }
      const tokens = await issueTokenPair({
        email: stored.email,
        clientId: stored.clientId,
        scope: stored.scope,
      });
      return Response.json(tokens);
    } catch {
      return jsonError("invalid_grant", "Refresh token is invalid");
    }
  }

  return jsonError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

function jsonError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status },
  );
}

export function registerClient(body: unknown): {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
} {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const redirectUris = Array.isArray(input.redirect_uris)
    ? input.redirect_uris.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  if (redirectUris.length === 0) {
    throw Object.assign(new Error("redirect_uris is required"), {
      status: 400,
    });
  }
  const method =
    typeof input.token_endpoint_auth_method === "string"
      ? input.token_endpoint_auth_method
      : "none";
  const clientId = randomUUID();
  const confidential = method !== "none";
  const clientSecret = confidential ? randomBytes(32).toString("hex") : null;
  saveRegisteredClient({
    clientId,
    clientSecret,
    redirectUris,
    tokenEndpointAuthMethod: method,
  });
  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export async function isValidMcpRequest(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() ?? "";
  if (!token) return false;
  return (await verifyMcpAccessToken(token)) !== null;
}

export async function verifyMcpAccessToken(
  token: string,
): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
      audience: mcpResourceUrl(),
      issuer: appOrigin(),
    });
    if (payload.purpose !== "mcp_access") return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email || !isAllowedEmail(email)) return null;
    return { email };
  } catch {
    return null;
  }
}
