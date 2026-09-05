import { NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "Expected JSON" },
      { status: 400 },
    );
  }

  try {
    const created = registerClient(body);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: message },
      { status: 400 },
    );
  }
}
