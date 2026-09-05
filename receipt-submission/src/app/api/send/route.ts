import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { renderPdfFirstPageToJpeg } from "@/lib/pdf-to-image";
import { saveReceipt } from "@/lib/receipts-store";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export async function POST(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("receipt");

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: "No receipt image provided" },
        { status: 400 },
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Image is too large (max 8 MB)" },
        { status: 400 },
      );
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ];
    const isPdf =
      file.type === "application/pdf" ||
      (!file.type && file.name?.toLowerCase().endsWith(".pdf"));
    if (
      !isPdf &&
      file.type &&
      !allowedTypes.includes(file.type) &&
      !file.type.startsWith("image/")
    ) {
      return NextResponse.json(
        { error: "File must be an image or a PDF" },
        { status: 400 },
      );
    }

    // A receipt held on the phone while the server was down uploads later than it
    // was taken, so the client's capture time wins when it sends one. Its local
    // wall clock is used verbatim so a late upload still files under capture time.
    const capturedAt = formData.get("capturedAt");
    const parts =
      typeof capturedAt === "string"
        ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(capturedAt)
        : null;

    const stamp = parts
      ? `${parts[1]}-${parts[2]}-${parts[3]}_${parts[4]}-${parts[5]}-${parts[6]}`
      : new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .slice(0, 19);
    const filename = `receipt_${stamp}.jpg`;
    const rawBytes = Buffer.from(await file.arrayBuffer());

    let bytes: Buffer = rawBytes;
    let mimeType = file.type || "image/jpeg";
    if (isPdf) {
      try {
        const converted = await renderPdfFirstPageToJpeg(rawBytes);
        bytes = converted.bytes;
        mimeType = converted.mimeType;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not convert PDF";
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    const saved = await saveReceipt({
      bytes,
      submittedBy: session.email,
      filename,
      mimeType,
    });

    return NextResponse.json({
      ok: true,
      id: saved.id,
      createdAt: saved.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("Send route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
