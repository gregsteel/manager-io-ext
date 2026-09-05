import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { deleteReceipt, getReceipt } from "@/lib/receipts-store";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const receipt = getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (receipt.processedAt) {
    return NextResponse.json(
      {
        error:
          "This receipt is marked processed. Mark it unprocessed first if you're sure you want to delete it.",
      },
      { status: 409 },
    );
  }

  await deleteReceipt(id);
  return NextResponse.json({ ok: true });
}
