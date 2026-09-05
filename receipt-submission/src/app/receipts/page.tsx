import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { needsHumanReview, parseAnalysis } from "@/lib/analysis";
import { isMobileRequest } from "@/lib/is-mobile-request";
import { listReceipts, type ReceiptRecord } from "@/lib/receipts-store";

type Filter = "all" | "needs_review" | "processed";

const TABS: { value: Filter; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "all", label: "All" },
  { value: "processed", label: "Processed" },
];

function status(receipt: ReceiptRecord): {
  label: string;
  className: string;
  reason: string;
} {
  if (receipt.processedAt) {
    return { label: "Processed", className: "bg-success/10 text-success", reason: "" };
  }
  if (receipt.analysedAt) {
    const analysis = parseAnalysis(receipt.analysisJson);
    if (needsHumanReview(analysis)) {
      return {
        label: "Needs review",
        className: "bg-danger/10 text-danger",
        reason: analysis.confidenceReason,
      };
    }
    return {
      label: "Analysed",
      className: "bg-accent-soft text-accent-pressed",
      reason: "",
    };
  }
  return { label: "Not yet analysed", className: "bg-black/5 text-muted", reason: "" };
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const isMobile = await isMobileRequest();

  const { filter: rawFilter } = await searchParams;
  const filter: Filter =
    rawFilter === "all" || rawFilter === "processed" ? rawFilter : "needs_review";

  const all = listReceipts({ limit: 200 });
  const receipts = all.filter((r) => {
    if (filter === "all") return true;
    if (filter === "processed") return r.processedAt !== null;
    return r.processedAt === null;
  });

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pb-16">
      <header
        className="pb-4"
        style={{ paddingTop: "max(1.25rem, var(--safe-top))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium tracking-wide text-muted uppercase">
              Receipts
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              All receipts
            </h1>
          </div>
          {!isMobile ? (
            <Link
              href="/upload"
              className="shrink-0 rounded-lg border border-black/10 bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-accent/40"
            >
              Upload
            </Link>
          ) : null}
        </div>
        <nav className="mt-4 flex gap-1 rounded-xl bg-black/5 p-1">
          {TABS.map((tab) => (
            <Link
              key={tab.value}
              href={tab.value === "needs_review" ? "/receipts" : `/receipts?filter=${tab.value}`}
              className={`flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
                filter === tab.value
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted"
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      {receipts.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">
          No receipts here.
        </p>
      ) : (
        <ul className="space-y-3">
          {receipts.map((receipt) => {
            const s = status(receipt);
            return (
              <li key={receipt.id}>
                <Link
                  href={`/review/${receipt.id}`}
                  className="flex items-center gap-3 rounded-xl border border-black/10 bg-surface p-3 transition-colors hover:border-accent/40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/receipts/${receipt.id}/image`}
                    alt=""
                    className="h-16 w-16 shrink-0 rounded-lg object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {receipt.filename}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {new Date(receipt.createdAt).toLocaleString()} ·{" "}
                      {receipt.submittedBy}
                    </p>
                    <span
                      className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
                    >
                      {s.label}
                    </span>
                    {s.reason ? (
                      <p className="mt-1 truncate text-xs text-danger">{s.reason}</p>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
