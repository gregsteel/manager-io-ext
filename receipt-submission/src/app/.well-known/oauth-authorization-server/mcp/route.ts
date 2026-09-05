import { jsonMetadata, OPTIONS } from "@/lib/oauth-metadata-response";
import { authorizationServerMetadata } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

export function GET() {
  return jsonMetadata(authorizationServerMetadata());
}

export { OPTIONS };
