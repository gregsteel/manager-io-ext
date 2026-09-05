import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  verifyImageAccessToken,
  verifyImageUploadToken,
} from "@/lib/auth/image-token";
import {
  isAllowedReceiptImageMime,
  RECEIPT_IMAGE_MAX_BYTES,
} from "@/lib/fetch-receipt-image";
import {
  attachReceiptImage,
  getReceipt,
  readReceiptImage,
} from "@/lib/receipts-store";

export const runtime = "nodejs";

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Session cookie/Bearer (review page, human use) or a short-lived
  // token scoped to this receipt (manager-mcp fetching on Cowork's
  // behalf — see docs/SIGNED_IMAGE_URL.md) — either is sufficient.
  // Upload tokens (image-upload) are not accepted for GET.
  const url = new URL(request.url);
  const imageToken = url.searchParams.get("token");
  const [session, tokenOk] = await Promise.all([
    getSession(request),
    verifyImageAccessToken(imageToken, id),
  ]);
  if (!session && !tokenOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const receipt = getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = await readReceiptImage(id);
  if (!bytes) {
    return NextResponse.json({ error: "Image missing" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": receipt.mimeType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

async function handleUpload(
  request: Request,
  id: string,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const headerToken = bearerToken(request);
  const [session, headerOk, queryOk] = await Promise.all([
    getSession(request),
    verifyImageUploadToken(headerToken, id),
    verifyImageUploadToken(queryToken, id),
  ]);
  if (!session && !headerOk && !queryOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!getReceipt(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let bytes: Buffer;
  let mimeType: string;
  let filename: string | undefined;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("receipt");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: "No receipt image provided" },
        { status: 400 },
      );
    }
    if (file.size > RECEIPT_IMAGE_MAX_BYTES) {
      return NextResponse.json(
        { error: "Image is too large (max 8 MB)" },
        { status: 400 },
      );
    }
    const fileType = file.type || "image/jpeg";
    if (fileType === "application/pdf" || !isAllowedReceiptImageMime(fileType)) {
      return NextResponse.json(
        { error: "File must be an image (PDF not supported)" },
        { status: 400 },
      );
    }
    bytes = Buffer.from(await file.arrayBuffer());
    mimeType = fileType.split(";")[0]?.trim() || "image/jpeg";
    if (file.name?.trim()) filename = file.name.trim();
  } else {
    const rawType = contentType.split(";")[0]?.trim().toLowerCase() || "";
    if (rawType === "application/pdf") {
      return NextResponse.json(
        { error: "PDF invoices are not supported; provide an image" },
        { status: 400 },
      );
    }
    if (rawType && !isAllowedReceiptImageMime(rawType)) {
      return NextResponse.json(
        { error: "File must be an image" },
        { status: 400 },
      );
    }
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length === 0) {
      return NextResponse.json(
        { error: "No receipt image provided" },
        { status: 400 },
      );
    }
    if (buf.length > RECEIPT_IMAGE_MAX_BYTES) {
      return NextResponse.json(
        { error: "Image is too large (max 8 MB)" },
        { status: 400 },
      );
    }
    bytes = buf;
    mimeType = rawType && isAllowedReceiptImageMime(rawType) ? rawType : "image/jpeg";
  }

  try {
    const updated = await attachReceiptImage(id, { bytes, mimeType, filename });
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      id: updated.id,
      createdAt: updated.createdAt,
      filename: updated.filename,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    if (message === "Receipt image already uploaded") {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error("Image upload error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleUpload(request, id);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleUpload(request, id);
}
