import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { mergeAnalysis, type ReceiptLineItem } from "@/lib/analysis";
import { getReceipt, saveAnalysis } from "@/lib/receipts-store";

export const runtime = "nodejs";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseItems(value: unknown): ReceiptLineItem[] {
  if (!Array.isArray(value)) return [];
  const items: ReceiptLineItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const description = asString(row.description);
    const amount = asNumberOrNull(row.amount);
    const category = asString(row.category);
    if (!description && amount === null && !category) continue;
    items.push({ description, amount, category });
  }
  return items;
}

export async function POST(
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = parseItems(body.items);
  if (items.length === 0) {
    return NextResponse.json(
      { error: "At least one item is required" },
      { status: 400 },
    );
  }

  const merged = mergeAnalysis(receipt.analysisJson, {
    vendor: asString(body.vendor),
    date: asString(body.date),
    dueDate: asString(body.dueDate),
    total: asNumberOrNull(body.total),
    currency: asString(body.currency),
    reference: asString(body.reference),
    notes: asString(body.notes),
    items,
    reviewedBy: session.email,
    reviewedAt: new Date().toISOString(),
  });

  // Deliberately does not call markProcessed: this finalises the split for
  // Cowork to load into Manager on its next run, which is what marks the
  // receipt processed.
  const updated = saveAnalysis(id, merged);

  return NextResponse.json({ ok: true, receipt: updated });
}
