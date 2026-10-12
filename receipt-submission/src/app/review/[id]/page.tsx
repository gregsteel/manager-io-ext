import { notFound, redirect } from "next/navigation";
import { ReceiptReview } from "@/components/ReceiptReview";
import { getSession } from "@/lib/auth/session";
import { parseAnalysis } from "@/lib/analysis";
import { getReceipt } from "@/lib/receipts-store";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  const receipt = getReceipt(id);
  if (!receipt) {
    notFound();
  }

  const analysis = parseAnalysis(receipt.analysisJson);

  return (
    <ReceiptReview
      receipt={{
        id: receipt.id,
        createdAt: receipt.createdAt,
        filename: receipt.filename,
        processedAt: receipt.processedAt,
        hasAnalysis: receipt.analysisJson !== null,
      }}
      analysis={analysis}
    />
  );
}
