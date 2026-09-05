import { jsonMetadata, OPTIONS } from "@/lib/oauth-metadata-response";
import { protectedResourceMetadata } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

export function GET() {
  return jsonMetadata(protectedResourceMetadata());
}

export { OPTIONS };
