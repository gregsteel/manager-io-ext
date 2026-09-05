import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { setProcessed } from "@/lib/receipts-store";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.processed !== "boolean") {
    return NextResponse.json(
      { error: "processed (boolean) is required" },
      { status: 400 },
    );
  }

  const updated = setProcessed(id, body.processed);
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, receipt: updated });
}
