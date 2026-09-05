import { NextResponse } from "next/server";
import {
  mcpWwwAuthenticate,
  verifyMcpAccessToken,
} from "@/lib/mcp-oauth";
import { handleMcpBody } from "@/lib/mcp-server";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": mcpWwwAuthenticate() },
    },
  );
}

async function mcpCaller(
  request: Request,
): Promise<{ email: string } | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() ?? "";
  if (!token) return null;
  return verifyMcpAccessToken(token);
}

export async function POST(request: Request) {
  const caller = await mcpCaller(request);
  if (!caller) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }

  const { status, payload } = await handleMcpBody(body, {
    email: caller.email,
  });
  if (payload === null) {
    return new NextResponse(null, { status });
  }
  return NextResponse.json(payload, {
    status,
    headers: {
      "mcp-session-id": "receipts",
    },
  });
}

export async function GET(request: Request) {
  if (!(await mcpCaller(request))) {
    return unauthorized();
  }
  return new NextResponse(null, { status: 405 });
}

export async function DELETE(request: Request) {
  if (!(await mcpCaller(request))) {
    return unauthorized();
  }
  return new NextResponse(null, { status: 200 });
}
