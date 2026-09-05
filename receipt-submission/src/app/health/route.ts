import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return new NextResponse("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
