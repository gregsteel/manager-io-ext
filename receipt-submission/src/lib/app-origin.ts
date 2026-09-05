/** Public origin of this app, derived from the Google OAuth callback URL. */
export function appOrigin(): string {
  const redirect = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (redirect) {
    try {
      return new URL(redirect).origin;
    } catch {
      /* fall through */
    }
  }
  return "http://localhost:55666";
}

/** MCP resource identifier — must match the URL entered in Claude. */
export function mcpResourceUrl(): string {
  return `${appOrigin()}/mcp`;
}
