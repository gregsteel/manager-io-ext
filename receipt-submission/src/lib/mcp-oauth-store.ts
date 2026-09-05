import { getReceiptsDb } from "@/lib/receipts-store";

export type RegisteredClient = {
  clientId: string;
  clientSecret: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
};

const globalForOAuth = globalThis as typeof globalThis & {
  mcpOAuthReady?: boolean;
};

function db() {
  const database = getReceiptsDb();
  if (!globalForOAuth.mcpOAuthReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        jti TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        jti TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        email TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    globalForOAuth.mcpOAuthReady = true;
  }
  return database;
}

export function saveRegisteredClient(client: RegisteredClient): void {
  db()
    .prepare(
      `INSERT INTO oauth_clients (
        client_id, client_secret, redirect_uris, token_endpoint_auth_method, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      client.clientId,
      client.clientSecret,
      JSON.stringify(client.redirectUris),
      client.tokenEndpointAuthMethod,
      new Date().toISOString(),
    );
}

export function getRegisteredClient(clientId: string): RegisteredClient | null {
  const row = db()
    .prepare(
      `SELECT client_id, client_secret, redirect_uris, token_endpoint_auth_method
       FROM oauth_clients WHERE client_id = ?`,
    )
    .get(clientId) as
    | {
        client_id: string;
        client_secret: string | null;
        redirect_uris: string;
        token_endpoint_auth_method: string;
      }
    | undefined;
  if (!row) return null;
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) {
      redirectUris = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    return null;
  }
  return {
    clientId: row.client_id,
    clientSecret: row.client_secret,
    redirectUris,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
  };
}

export function insertAuthCode(jti: string): void {
  db()
    .prepare(`INSERT INTO oauth_auth_codes (jti, created_at) VALUES (?, ?)`)
    .run(jti, new Date().toISOString());
}

/** Returns true if the code was unused and is now consumed. */
export function consumeAuthCode(jti: string): boolean {
  const result = db().prepare(`DELETE FROM oauth_auth_codes WHERE jti = ?`).run(jti);
  return Number(result.changes) > 0;
}

export function insertRefreshToken(input: {
  jti: string;
  clientId: string;
  email: string;
  scope: string;
  expiresAt: string;
}): void {
  db()
    .prepare(
      `INSERT INTO oauth_refresh_tokens (
        jti, client_id, email, scope, expires_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.jti, input.clientId, input.email, input.scope, input.expiresAt);
}

export function consumeRefreshToken(jti: string): {
  clientId: string;
  email: string;
  scope: string;
} | null {
  const row = db()
    .prepare(
      `SELECT client_id, email, scope FROM oauth_refresh_tokens WHERE jti = ?`,
    )
    .get(jti) as
    | { client_id: string; email: string; scope: string }
    | undefined;
  if (!row) return null;
  db().prepare(`DELETE FROM oauth_refresh_tokens WHERE jti = ?`).run(jti);
  return {
    clientId: row.client_id,
    email: row.email,
    scope: row.scope,
  };
}
